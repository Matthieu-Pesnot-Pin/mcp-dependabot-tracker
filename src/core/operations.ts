import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  DEFAULT_COMMIT_MESSAGE,
  type AuditScope,
  type Change,
  type Operation,
  type OperationKind,
  type Origin,
  type PullRequest,
  type Repair,
  type Repo,
  type StepName,
  type StepState,
  type Vulnerability,
} from "../../shared/schemas/model.schema.js";
import type { Settings } from "../../shared/schemas/settings.schema.js";
import { activityLine, type ClaudeRuntime } from "./claude.js";
import { CommandAbortedError, runCommand, tail, type CommandResult } from "./commands.js";
import type { GitHubConfig } from "./config.js";
import { ConflictError, TrackerError } from "./errors.js";
import { GitHubClient } from "./github.js";
import {
  diffLockfiles,
  parseAuditReport,
  parseLockfile,
  parseNpmJson,
  projectLabel,
  type Lockfile,
} from "./npm-audit.js";
import { auditFacts, repairVulnerabilities } from "./repair.js";
import { assertNotDeprecated, isActive, type Store } from "./store.js";

/** Accès aux données et à GitHub pour exécuter les opérations. */
export interface OperationContext {
  store: Store;
  /** Configuration GitHub, lue à chaque opération ; lève une erreur si GITHUB_TOKEN manque. */
  githubConfig: () => GitHubConfig;
  /** Dossier où créer le clone d'une opération, qui existe au retour. */
  cloneDir: () => string;
  /** Journalise une erreur d'une exécution en arrière-plan qui n'a pas pu être enregistrée dans l'opération. */
  logError: (message: string) => void;
  /** Réglages des corrections par Claude, relus à chaque correction. */
  settings: () => Settings;
  /** Commande et dossier de configuration de Claude Code. */
  claude: ClaudeRuntime;
}

/**
 * Choix d'une correction : le périmètre, et les corrections par Claude quand
 * `npm audit fix` laisse des vulnérabilités.
 */
export interface FixPlan {
  scope: AuditScope;
  claude: boolean;
}

/** Signal d'annulation de chaque opération en cours, par identifiant. */
const runningOperations = new Map<string, AbortController>();

const MAX_LOG_ENTRIES = 300;
const MAX_LOG_TEXT = 4000;

/** Dossier du clone dans le répertoire temporaire de l'opération. */
const CLONE_DIR = "repo";

/** Paquets listés dans le corps de la pull request. */
const MAX_PR_CHANGES = 60;

/** Dernières actions de Claude affichées pendant les corrections. */
const CLAUDE_ACTIVITY = 3;

/** Éléments du déroulé de la session de Claude gardés, les plus récents. */
const SESSION_EVENTS = 500;

/** Fichiers suivis par les commits du tracker : tout le clone, sauf les node_modules qu'installe Claude. */
const STAGED_PATHS = ["--", ".", ":(exclude,glob)**/node_modules/**"];

/** Co-auteur du commit des corrections par Claude. */
const CLAUDE_TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>";

function now(): string {
  return new Date().toISOString();
}

/** `fix/npm-audit-2026-10-28-143205`, à l'heure locale du serveur. */
export function branchName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `fix/npm-audit-${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Vrai pour une branche nommée par `branchName`. */
export function isTrackerBranch(branch: string): boolean {
  return /^fix\/npm-audit-\d{4}-\d{2}-\d{2}-\d{6}$/.test(branch);
}

/** Variables qui authentifient git auprès de GitHub par un en-tête HTTP, sans écrire le token dans le clone. */
function gitAuthEnv(config: GitHubConfig): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${config.token}`).toString("base64");
  return {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${config.serverUrl}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/**
 * Environnement des commandes npm. `allow_remote` autorise le téléchargement des
 * archives de paquets à `bundleDependencies` (ex. `@tailwindcss/oxide-wasm32-wasi`),
 * que npm 12 classe en dépendances distantes avec `--package-lock-only`.
 */
const NPM_ENV = { npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_allow_remote: "all" };

/** Options npm qui limitent l'audit et ses corrections au périmètre `scope`. */
function scopeArgs(scope: AuditScope): string[] {
  return scope === "production" ? ["--omit=dev"] : [];
}

/** Sous-commande git d'une liste d'arguments, après les options `-c clé=valeur`. */
function subcommand(args: string[]): string {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args[index] ?? "";
}

function newOperation(repo: Repo, kind: OperationKind, origin: Origin, scope: AuditScope): Operation {
  const createdAt = now();
  return {
    id: `op-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    repoId: repo.id,
    kind,
    origin,
    scope,
    status: "running",
    createdAt,
    updatedAt: createdAt,
    workDir: null,
    baseBranch: repo.branch,
    cancelRequested: false,
    steps: { clone: "pending", audit: "pending", fix: "pending", repair: "pending", push: "pending" },
    projects: [],
    counts: { initial: null, afterFix: null, afterRepair: null },
    found: [],
    remaining: [],
    changes: [],
    commitMessage: DEFAULT_COMMIT_MESSAGE,
    branch: null,
    pullRequest: null,
    repair: null,
    error: null,
    log: [],
  };
}

/** Exécution des étapes d'une opération, avec son signal d'annulation. */
class Runner {
  constructor(
    private readonly ctx: OperationContext,
    readonly id: string,
    readonly signal: AbortSignal,
    readonly config: GitHubConfig,
    readonly cloneDir: string
  ) {}

  get operation(): Operation {
    return this.ctx.store.getOperation(this.id);
  }

  update(fn: (operation: Operation) => Operation): Operation {
    return this.ctx.store.updateOperation(this.id, fn);
  }

  /** Ajoute une pull request ouverte à celles en attente du dépôt. */
  addPullRequest(pullRequest: PullRequest): void {
    this.ctx.store.updateRepo(this.operation.repoId, (repo) => ({
      ...repo,
      pullRequests: [...repo.pullRequests.filter((candidate) => candidate.number !== pullRequest.number), pullRequest],
    }));
  }

  setStep(step: StepName, state: StepState): void {
    this.update((operation) => ({ ...operation, steps: { ...operation.steps, [step]: state } }));
  }

  log(text: string): void {
    const entry = { at: now(), text: text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT)}…` : text };
    this.update((operation) => ({ ...operation, log: [...operation.log, entry].slice(-MAX_LOG_ENTRIES) }));
  }

  get repoDir(): string {
    const workDir = this.operation.workDir;
    if (!workDir) throw new TrackerError(`Operation ${this.id} has no clone.`);
    return path.join(workDir, CLONE_DIR);
  }

  private async run(command: "git" | "npm", args: string[], cwd: string, env: Record<string, string> = {}): Promise<CommandResult> {
    this.log(`$ ${command} ${args.join(" ")}`);
    return runCommand(command, args, { cwd, env, signal: this.signal });
  }

  /** git dans le clone ; un code de sortie non nul lève une erreur avec la fin de stderr. */
  async git(args: string[], options: { cwd?: string; auth?: boolean } = {}): Promise<string> {
    const result = await this.run("git", args, options.cwd ?? this.repoDir, options.auth ? gitAuthEnv(this.config) : {});
    if (result.code !== 0) {
      const detail = tail(result.stderr) || tail(result.stdout);
      this.log(detail);
      throw new TrackerError(`git ${subcommand(args)} failed: ${detail}`);
    }
    return result.stdout;
  }

  /** npm dans le dossier d'un projet du clone ; sa sortie JSON est lue même avec un code de sortie non nul. */
  async npm(project: string, args: string[]): Promise<any> {
    const result = await this.run("npm", args, path.join(this.repoDir, project), NPM_ENV);
    return parseNpmJson(result.stdout, result.stderr, `npm ${args.slice(0, args.indexOf("--json")).join(" ")} in ${projectLabel(project) || "./"}`);
  }

  readLock(project: string): Lockfile {
    const file = path.join(this.repoDir, project, "package-lock.json");
    return parseLockfile(fs.readFileSync(file, "utf-8"), project);
  }

  /**
   * Commit cloné : HEAD tant que le tracker n'a rien commité ; après le commit
   * de `npm audit fix`, son parent, et sans ce commit, la base des corrections
   * par Claude.
   */
  get clonedCommit(): string {
    const repair = this.operation.repair;
    if (!repair) return "HEAD";
    return repair.auditCommit ? `${repair.auditCommit}~1` : repair.base;
  }

  /** Lockfile du projet tel qu'il est dans le commit cloné. */
  async originalLock(project: string): Promise<Lockfile> {
    const file = project === "" ? "package-lock.json" : `${project}/package-lock.json`;
    return parseLockfile(await this.git(["show", `${this.clonedCommit}:${file}`]), project);
  }
}

// --- Étapes -------------------------------------------------------------------

async function cloneStep(runner: Runner): Promise<void> {
  runner.setStep("clone", "running");
  const operation = runner.operation;
  const [owner, name] = operation.repoId.split("/");
  const workDir = fs.mkdtempSync(path.join(runner.cloneDir, "mcp-dependabot-tracker-"));
  runner.update((current) => ({ ...current, workDir }));
  const url = `${runner.config.serverUrl}/${owner}/${name}.git`;
  await runner.git(["-c", "core.autocrlf=false", "clone", "--depth", "1", "--branch", operation.baseBranch, "--single-branch", url, CLONE_DIR], {
    cwd: workDir,
    auth: true,
  });

  const files = (await runner.git(["ls-files", "-z"])).split("\0");
  const projects = files
    .filter((file) => file === "package-lock.json" || file.endsWith("/package-lock.json"))
    .map((file) => path.posix.dirname(file))
    .map((dir) => (dir === "." ? "" : dir))
    .sort();
  if (projects.length === 0) {
    throw new TrackerError(`No package-lock.json is tracked in ${operation.repoId}: npm audit needs a lockfile.`);
  }
  runner.update((current) => ({ ...current, projects }));
  runner.log(`npm projects: ${projects.map((project) => projectLabel(project) || "./").join(", ")}`);
  runner.setStep("clone", "done");
}

/** `npm audit` dans chaque projet ; enregistre le total sous `count` et les vulnérabilités restantes. */
async function auditAll(runner: Runner, count: keyof Operation["counts"]): Promise<Vulnerability[]> {
  const vulnerabilities: Vulnerability[] = [];
  for (const project of runner.operation.projects) {
    const report = await runner.npm(project, ["audit", ...scopeArgs(runner.operation.scope), "--json"]);
    vulnerabilities.push(...parseAuditReport(report, project));
  }
  runner.log(`${vulnerabilities.length} vulnerabilit${vulnerabilities.length === 1 ? "y" : "ies"}`);
  runner.update((operation) => ({
    ...operation,
    counts: { ...operation.counts, [count]: vulnerabilities.length },
    remaining: vulnerabilities,
  }));
  return vulnerabilities;
}

/** Vulnérabilités restantes de chaque projet, d'après un nouvel `npm audit`, sans toucher aux comptes de l'opération. */
async function currentAuditFacts(runner: Runner): Promise<unknown[]> {
  const facts: unknown[] = [];
  for (const project of runner.operation.projects) {
    facts.push(...auditFacts(await runner.npm(project, ["audit", ...scopeArgs(runner.operation.scope), "--json"]), project));
  }
  return facts;
}

/** Paquets modifiés depuis le commit cloné, dans tous les projets. */
async function refreshChanges(runner: Runner): Promise<void> {
  const changes: Change[] = [];
  for (const project of runner.operation.projects) {
    changes.push(...diffLockfiles(await runner.originalLock(project), runner.readLock(project), project));
  }
  runner.update((operation) => ({ ...operation, changes }));
}

async function auditStep(runner: Runner): Promise<Vulnerability[]> {
  runner.setStep("audit", "running");
  const vulnerabilities = await auditAll(runner, "initial");
  runner.update((operation) => ({ ...operation, found: operation.remaining }));
  runner.setStep("audit", "done");
  return vulnerabilities;
}

/** `npm audit fix` dans les projets vulnérables, sans installer node_modules ni lancer de scripts. */
async function fixStep(runner: Runner, vulnerabilities: Vulnerability[]): Promise<Vulnerability[]> {
  runner.setStep("fix", "running");
  const projects = new Set(vulnerabilities.map((vulnerability) => vulnerability.project));
  for (const project of runner.operation.projects.filter((candidate) => projects.has(candidate))) {
    await runner.npm(project, ["audit", "fix", ...scopeArgs(runner.operation.scope), "--package-lock-only", "--ignore-scripts", "--json"]);
  }
  const remaining = await auditAll(runner, "afterFix");
  await refreshChanges(runner);
  runner.setStep("fix", "done");
  return remaining;
}

/** Options git qui signent un commit au nom de l'utilisateur du token GitHub. */
async function commitIdentity(runner: Runner): Promise<string[]> {
  const user = await new GitHubClient(runner.config).getAuthenticatedUser();
  return ["-c", `user.name=${user.name ?? user.login}`, "-c", `user.email=${user.id}+${user.login}@users.noreply.github.com`];
}

/** Vrai si l'index contient des changements à commiter. */
async function hasStagedChanges(runner: Runner): Promise<boolean> {
  return (await runner.git(["diff", "--cached", "--name-only"])).trim() !== "";
}

/**
 * Crée la branche de la correction et y commite les lockfiles modifiés par
 * `npm audit fix`, s'ils ont changé ; rend le commit sur lequel reposeront les
 * corrections par Claude, et celui de `npm audit fix`, null sans changement.
 */
async function commitAuditFixes(runner: Runner): Promise<{ base: string; auditCommit: string | null }> {
  const branch = runner.operation.branch ?? branchName(new Date());
  runner.update((operation) => ({ ...operation, branch }));
  await runner.git(["checkout", "-b", branch]);
  await runner.git(["add", "-A", ...STAGED_PATHS]);
  const committed = await hasStagedChanges(runner);
  if (committed) await runner.git([...(await commitIdentity(runner)), "commit", "-m", runner.operation.commitMessage]);
  const base = (await runner.git(["rev-parse", "HEAD"])).trim();
  return { base, auditCommit: committed ? base : null };
}

/**
 * Remplace le commit des corrections par Claude par un seul commit de tout ce
 * qui a changé depuis `base` ; rend ce commit, ou null quand rien n'a changé.
 */
async function commitRepair(runner: Runner, base: string, message: string): Promise<string | null> {
  await runner.git(["reset", "--soft", base]);
  await runner.git(["add", "-A", ...STAGED_PATHS]);
  if (!(await hasStagedChanges(runner))) return null;
  await runner.git([...(await commitIdentity(runner)), "commit", "-m", message, "-m", CLAUDE_TRAILER]);
  return (await runner.git(["rev-parse", "HEAD"])).trim();
}

/**
 * Corrections par Claude des vulnérabilités restantes : la branche est créée et
 * `npm audit fix` y est commité, puis Claude analyse et corrige en une session,
 * dont les changements font un seul commit. Un échec, configuration manquante
 * comprise, remet le clone dans l'état du commit de `npm audit fix` et laisse
 * l'opération se poursuivre ; seule une annulation l'interrompt.
 */
async function repairStep(runner: Runner, ctx: OperationContext): Promise<void> {
  runner.setStep("repair", "running");
  const { base, auditCommit } = await commitAuditFixes(runner);
  const repair: Repair = { startedAt: now(), endedAt: null, turns: 0, activity: [], events: [], base, auditCommit, commit: null, report: null, task: null, error: null };
  runner.update((operation) => ({ ...operation, repair }));
  const repaired = (fn: (current: Repair) => Repair) => runner.update((operation) => ({ ...operation, repair: operation.repair && fn(operation.repair) }));

  try {
    const operation = runner.operation;
    const { report, task } = await repairVulnerabilities({
      repoId: operation.repoId,
      branch: operation.baseBranch,
      scope: operation.scope,
      cwd: runner.repoDir,
      workDir: operation.workDir!,
      facts: await currentAuditFacts(runner),
      settings: ctx.settings(),
      claude: ctx.claude,
      signal: runner.signal,
      onEvent: (event, turns) => {
        const line = activityLine(event);
        runner.log(`claude: ${line}`);
        repaired((current) => ({
          ...current,
          turns,
          activity: [...current.activity, line].slice(-CLAUDE_ACTIVITY),
          events: [...current.events, event].slice(-SESSION_EVENTS),
        }));
      },
    });
    const commit = await commitRepair(runner, base, report.commitMessage);
    runner.log(`Report of Claude ${task.key}: ${task.url}`);
    await auditAll(runner, "afterRepair");
    await refreshChanges(runner);
    repaired((current) => ({ ...current, endedAt: now(), commit, report, task }));
    runner.setStep("repair", "done");
  } catch (err: any) {
    if (err instanceof CommandAbortedError || runner.signal.aborted) throw err;
    const message = err?.message ?? String(err);
    runner.log(`Fixes by Claude failed: ${message}`);
    await runner.git(["reset", "--hard", "HEAD"]);
    await runner.git(["clean", "-fd", "-e", "node_modules"]);
    repaired((current) => ({ ...current, endedAt: now(), error: message }));
    runner.setStep("repair", "failed");
  }
}

/** Avertissements en tête de la pull request : échec de Claude, ou tests en échec après ses corrections. */
function pullRequestWarnings(operation: Operation): string[] {
  const repair = operation.repair;
  if (repair?.error) {
    return [`> [!WARNING]`, `> Claude Code could not fix the remaining vulnerabilities: ${repair.error}`, `> This pull request only holds the fixes of \`npm audit fix\`.`, ""];
  }
  if (repair?.report?.tests.outcome === "failed") {
    return [`> [!WARNING]`, `> The tests failed after the fixes by Claude Code: ${repair.report.tests.detail}`, ""];
  }
  return [];
}

function pullRequestBody(operation: Operation): string {
  const after = operation.counts.afterRepair ?? operation.counts.afterFix;
  const repair = operation.repair?.report ? operation.repair : null;
  const command = ["npm audit fix", ...scopeArgs(operation.scope), "--package-lock-only --ignore-scripts"].join(" ");
  const lines = [
    ...pullRequestWarnings(operation),
    `Automated \`npm audit\` fixes, made by mcp-dependabot-tracker in a temporary clone (\`${command}\`).`,
    "",
    operation.scope === "production"
      ? "- Scope: production dependencies only; the vulnerabilities of the devDependencies were neither audited nor fixed."
      : "- Scope: all dependencies, devDependencies included.",
    `- Vulnerabilities before: ${operation.counts.initial}`,
    `- Vulnerabilities after: ${after}`,
    "",
    `Updated packages (${operation.changes.length}):`,
    "",
  ];
  for (const change of operation.changes.slice(0, MAX_PR_CHANGES)) {
    lines.push(`- \`${projectLabel(change.project)}${change.name}\` ${change.from ?? "(added)"} → ${change.to ?? "(removed)"}`);
  }
  if (operation.changes.length > MAX_PR_CHANGES) lines.push(`- … and ${operation.changes.length - MAX_PR_CHANGES} more`);
  if (repair?.report) {
    lines.push("", `Fixes by Claude Code${repair.task ? `, reported in organizer task ${repair.task.key}` : ""}:`, "", repair.report.summary, "");
    for (const change of repair.report.changes) lines.push(`- \`${change.file}\`: ${change.change}`);
    lines.push(`- Tests: ${repair.report.tests.outcome.replace("_", " ")} — ${repair.report.tests.detail}`);
  }
  return lines.join("\n");
}

/**
 * Commit des lockfiles modifiés sur une nouvelle branche, push, puis pull
 * request vers la branche analysée. Après les corrections par Claude, la
 * branche et ses commits existent déjà : seuls le push et la pull request
 * restent à faire.
 */
async function pushStep(runner: Runner): Promise<void> {
  runner.setStep("push", "running");
  const operation = runner.operation;
  const [owner, name] = operation.repoId.split("/");
  const github = new GitHubClient(runner.config);
  const branch = operation.branch ?? branchName(new Date());
  runner.update((current) => ({ ...current, branch }));

  if (!operation.repair) {
    await runner.git(["checkout", "-b", branch]);
    await runner.git(["add", "-A", ...STAGED_PATHS]);
    if (!(await hasStagedChanges(runner))) throw new TrackerError("Nothing to commit: the fixes left the files unchanged.");
    await runner.git([...(await commitIdentity(runner)), "commit", "-m", operation.commitMessage]);
  }
  await runner.git(["push", "origin", `HEAD:refs/heads/${branch}`], { auth: true });

  const title = operation.commitMessage.split(/\r?\n/)[0];
  let pullRequest;
  try {
    pullRequest = await github.createPullRequest(owner, name, { title, head: branch, base: operation.baseBranch, body: pullRequestBody(runner.operation) });
  } catch (err: any) {
    throw new TrackerError(`Branch ${branch} was pushed, but the pull request could not be opened: ${err?.message ?? err}`);
  }
  runner.log(`Pull request #${pullRequest.number}: ${pullRequest.url}`);
  runner.update((current) => ({ ...current, pullRequest: { number: pullRequest.number, url: pullRequest.url } }));
  runner.addPullRequest({ number: pullRequest.number, url: pullRequest.url, branch, createdAt: pullRequest.createdAt });
  runner.setStep("push", "done");
}

// --- Enchaînement ------------------------------------------------------------

function finish(runner: Runner): void {
  runner.update((operation) => ({
    ...operation,
    status: "done",
    steps: Object.fromEntries(
      Object.entries(operation.steps).map(([step, state]) => [step, state === "pending" ? "skipped" : state])
    ) as Operation["steps"],
  }));
}

/** Vrai quand la correction a quelque chose à pousser : des lockfiles modifiés ou un commit sur sa branche. */
function hasChangesToPush(operation: Operation): boolean {
  return operation.changes.length > 0 || operation.repair?.auditCommit != null || operation.repair?.commit != null;
}

/**
 * Exécute `body` pour l'opération `id`, avec un signal que déclenche
 * `cancelOperation`. Une erreur fait échouer l'opération et l'étape en cours ;
 * une opération terminée perd son clone.
 */
async function execute(ctx: OperationContext, id: string, body: (runner: Runner) => Promise<void>): Promise<Operation> {
  const controller = new AbortController();
  runningOperations.set(id, controller);
  try {
    const runner = new Runner(ctx, id, controller.signal, ctx.githubConfig(), ctx.cloneDir());
    await body(runner);
  } catch (err: any) {
    const cancelled = err instanceof CommandAbortedError || controller.signal.aborted;
    ctx.store.updateOperation(id, (operation) => ({
      ...operation,
      status: cancelled ? "cancelled" : "failed",
      error: cancelled ? null : (err?.message ?? String(err)),
      steps: Object.fromEntries(
        Object.entries(operation.steps).map(([step, state]) => [
          step,
          state === "running" ? (cancelled ? "skipped" : "failed") : state === "pending" ? "skipped" : state,
        ])
      ) as Operation["steps"],
    }));
  } finally {
    runningOperations.delete(id);
  }
  return cleanUp(ctx, id);
}

/** Supprime le clone d'une opération terminée. */
function cleanUp(ctx: OperationContext, id: string): Operation {
  const operation = ctx.store.getOperation(id);
  if (isActive(operation) || !operation.workDir) return operation;
  fs.rmSync(operation.workDir, { recursive: true, force: true });
  return ctx.store.updateOperation(id, (current) => ({ ...current, workDir: null }));
}

/** Laisse une exécution se poursuivre en arrière-plan ; une erreur imprévue est journalisée. */
function inBackground(ctx: OperationContext, id: string, run: Promise<Operation>): void {
  run.catch((err: any) => ctx.logError(`Operation ${id} could not be recorded: ${err?.stack ?? err}`));
}

// --- Entrées ---------------------------------------------------------------------

/**
 * Lance une correction de la branche analysée, lancée par `origin`, menée en
 * arrière-plan jusqu'au bout sans intervention : clone, audit, `npm audit fix`,
 * corrections par Claude s'il reste des vulnérabilités et que `plan` les
 * demande, puis commit, push et pull request s'il y a quelque chose à pousser.
 * Refusé si une opération est en cours sur le dépôt, ou s'il est déprécié.
 */
export function startFix(ctx: OperationContext, repoId: string, origin: Origin, plan: FixPlan): Operation {
  ctx.githubConfig();
  const repo = ctx.store.getRepo(repoId);
  assertNotDeprecated(repo);
  const operation = ctx.store.createOperation(newOperation(repo, "fix", origin, plan.scope));
  inBackground(
    ctx,
    operation.id,
    execute(ctx, operation.id, async (runner) => {
      await cloneStep(runner);
      const vulnerabilities = await auditStep(runner);
      if (vulnerabilities.length === 0) return finish(runner);
      const remaining = await fixStep(runner, vulnerabilities);
      if (remaining.length > 0 && plan.claude) {
        await repairStep(runner, ctx);
      } else {
        runner.setStep("repair", "skipped");
      }
      if (hasChangesToPush(runner.operation)) await pushStep(runner);
      finish(runner);
    })
  );
  return operation;
}

/**
 * Lance un audit de la branche analysée sur le périmètre `scope`, lancé par
 * `origin` et mené en arrière-plan : clone et `npm audit`, sans rien modifier.
 * Refusé si une opération est en cours sur le dépôt, ou s'il est déprécié.
 */
export function startAudit(ctx: OperationContext, repoId: string, origin: Origin, scope: AuditScope): Operation {
  ctx.githubConfig();
  const repo = ctx.store.getRepo(repoId);
  assertNotDeprecated(repo);
  const operation = ctx.store.createOperation(newOperation(repo, "audit", origin, scope));
  inBackground(
    ctx,
    operation.id,
    execute(ctx, operation.id, async (runner) => {
      await cloneStep(runner);
      await auditStep(runner);
      finish(runner);
    })
  );
  return operation;
}

/**
 * Audit de la branche par défaut, celle que Dependabot analyse, sur le
 * périmètre `scope`, lancé par l'utilisateur et attendu jusqu'à sa fin. Refusé
 * si une opération est en cours sur le dépôt, ou s'il est déprécié.
 */
export async function runDefaultBranchAudit(ctx: OperationContext, repoId: string, scope: AuditScope): Promise<Operation> {
  ctx.githubConfig();
  const repo = ctx.store.getRepo(repoId);
  assertNotDeprecated(repo);
  const operation = ctx.store.createOperation({ ...newOperation(repo, "audit", "user", scope), baseBranch: repo.defaultBranch });
  return execute(ctx, operation.id, async (runner) => {
    await cloneStep(runner);
    await auditStep(runner);
    finish(runner);
  });
}

/**
 * Périmètre de l'audit qui suit la fusion des pull requests `numbers` : celui
 * de la plus récente des corrections qui les ont ouvertes, ou la production,
 * périmètre par défaut, quand aucune opération enregistrée ne les a ouvertes.
 * `operations` va de la plus récente à la plus ancienne.
 */
export function mergeAuditScope(operations: Operation[], numbers: number[]): AuditScope {
  return operations.find((operation) => operation.pullRequest !== null && numbers.includes(operation.pullRequest.number))?.scope ?? "production";
}

/**
 * Vérifie que l'audit qui suit une fusion peut démarrer : token GitHub
 * déclaré, aucune opération en cours sur le dépôt.
 */
export function assertMergeAuditPossible(ctx: OperationContext, repoId: string): void {
  ctx.githubConfig();
  const active = ctx.store.activeOperation(repoId);
  if (active) throw new ConflictError(`An operation is in progress on ${repoId} (${active.id}): wait for it to finish or cancel it before marking its pull requests merged, so that the default branch can be audited.`);
}

/**
 * Lance en arrière-plan l'audit de la branche par défaut après la fusion des
 * pull requests `numbers` du tracker, pour que la liste reflète aussitôt la
 * branche fusionnée, sans attendre Dependabot. Un échec en cours d'audit est
 * enregistré dans l'opération.
 */
export function startMergeAudit(ctx: OperationContext, repoId: string, numbers: number[]): void {
  const scope = mergeAuditScope(ctx.store.listOperations(repoId), numbers);
  runDefaultBranchAudit(ctx, repoId, scope).catch((err: any) => ctx.logError(`Audit of ${repoId} after merge could not start: ${err?.message ?? err}`));
}

/**
 * Annule une opération en cours : sa commande est arrêtée, Claude Code compris,
 * et son clone supprimé ; rien n'est poussé.
 */
export function cancelOperation(ctx: OperationContext, id: string): Operation {
  const operation = ctx.store.updateOperation(id, (current) => {
    if (!isActive(current)) throw new ConflictError(`Operation ${id} is already ${current.status}.`);
    return { ...current, cancelRequested: true };
  });
  runningOperations.get(id)?.abort();
  return operation;
}
