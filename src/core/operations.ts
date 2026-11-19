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
  type Project,
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
import { CACHE_DIR, assertContainersAvailable, buildImage, pullImage, type ContainerRuntime, type Workspace } from "./containers.js";
import { PACKAGE_MANAGERS, detectProjects, diffLockfiles, installedDirs, lockfilePath, managerOf } from "./managers/index.js";
import { projectLabel, type Lockfile, type ManagerContext } from "./managers/types.js";
import { repairVulnerabilities } from "./repair.js";
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
  /** Podman, qui exécute les commandes des gestionnaires de paquets. */
  containers: ContainerRuntime;
}

/**
 * Choix d'une correction : le périmètre, et les corrections par Claude quand
 * les corrections automatiques laissent des vulnérabilités.
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

/** Dépôt git du clone, à côté de lui dans le répertoire temporaire de l'opération : le clone n'a pas de `.git`. */
const GIT_DIR = "git";

/** Paquets listés dans le corps de la pull request. */
const MAX_PR_CHANGES = 60;

/** Dernières actions de Claude affichées pendant les corrections. */
const CLAUDE_ACTIVITY = 3;

/** Éléments du déroulé de la session de Claude gardés, les plus récents. */
const SESSION_EVENTS = 500;

/**
 * Fichiers suivis par les commits du tracker : tout le clone, sauf les
 * dépendances qu'installe Claude, `node_modules` et le `vendor` des projets
 * Composer.
 */
function stagedPaths(projects: Project[]): string[] {
  return ["--", ".", ":(exclude,glob)**/node_modules/**", ...projects.flatMap(installedDirs).map((dir) => `:(exclude,glob)${dir}/**`)];
}

/**
 * Fichiers que le bac à sable de Claude Code garde en lecture seule. Absents
 * du dépôt, il les crée vides dans le clone pour les monter : ces fichiers-là
 * ne font pas partie des corrections.
 */
const SANDBOX_PLACEHOLDERS = new Set([".gitmodules", ".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml", "pnpm-lock.yaml", "yarn.lock"]);

/** Co-auteur du commit des corrections par Claude. */
const CLAUDE_TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>";

function now(): string {
  return new Date().toISOString();
}

/** `fix/deps-audit-2026-10-28-143205`, à l'heure locale du serveur. */
export function branchName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `fix/deps-audit-${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Vrai pour une branche du tracker : `fix/deps-audit-…`, nommée par `branchName`, ou `fix/npm-audit-…`. */
export function isTrackerBranch(branch: string): boolean {
  return /^fix\/(deps|npm)-audit-\d{4}-\d{2}-\d{2}-\d{6}$/.test(branch);
}

/** Réglage git passé à une commande par son environnement : clé et valeur. */
type GitSetting = [key: string, value: string];

/** Réglages de toutes les commandes git : aucun hook, aucun moniteur de fichiers. */
const GIT_SETTINGS: GitSetting[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
];

/** Réglage qui authentifie git auprès de GitHub par un en-tête HTTP, sans écrire le token dans le clone. */
function gitAuthSetting(config: GitHubConfig): GitSetting {
  const basic = Buffer.from(`x-access-token:${config.token}`).toString("base64");
  return [`http.${config.serverUrl}/.extraheader`, `AUTHORIZATION: basic ${basic}`];
}

/** Variables d'une commande git : aucune question posée à l'utilisateur, et `settings` en réglages. */
function gitEnv(settings: GitSetting[]): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_CONFIG_COUNT: String(settings.length) };
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
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
    readonly cloneDir: string,
    readonly containers: ContainerRuntime
  ) {}

  /** Vulnérabilités du dernier audit, réduites à ce qui sert les corrections par Claude. */
  facts: unknown[] = [];

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

  private async run(args: string[], cwd: string, env: Record<string, string>): Promise<CommandResult> {
    this.log(`$ git ${args.join(" ")}`);
    return runCommand("git", args, { cwd, env, signal: this.signal });
  }

  get gitDir(): string {
    const workDir = this.operation.workDir;
    if (!workDir) throw new TrackerError(`Operation ${this.id} has no clone.`);
    return path.join(workDir, GIT_DIR);
  }

  /**
   * git dans le clone, sur le dépôt de l'opération désigné par GIT_DIR et
   * GIT_WORK_TREE, ou dans `options.cwd` sans dépôt désigné ; un code de sortie
   * non nul lève une erreur avec la fin de stderr.
   */
  async git(args: string[], options: { cwd?: string; auth?: boolean } = {}): Promise<string> {
    const env = gitEnv(options.auth ? [...GIT_SETTINGS, gitAuthSetting(this.config)] : GIT_SETTINGS);
    if (options.cwd === undefined) Object.assign(env, { GIT_DIR: this.gitDir, GIT_WORK_TREE: this.repoDir });
    const result = await this.run(args, options.cwd ?? this.repoDir, env);
    if (result.code !== 0) {
      const detail = tail(result.stderr) || tail(result.stdout);
      this.log(detail);
      throw new TrackerError(`git ${subcommand(args)} failed: ${detail}`);
    }
    return result.stdout;
  }

  /** Clone et cache de l'opération, montés dans les conteneurs. */
  get workspace(): Workspace {
    return { root: this.repoDir, cache: path.join(this.operation.workDir!, CACHE_DIR) };
  }

  /** Contexte des commandes des gestionnaires de paquets de l'opération. */
  get managers(): ManagerContext {
    return { runtime: this.containers, workspace: this.workspace, scope: this.operation.scope, signal: this.signal, log: (text) => this.log(text) };
  }

  readLock(project: Project): Lockfile {
    const file = path.join(this.repoDir, lockfilePath(project));
    return managerOf(project.manager).readLock(fs.readFileSync(file, "utf-8"), project.path);
  }

  /**
   * Commit cloné : HEAD tant que le tracker n'a rien commité ; après le commit
   * des corrections automatiques, son parent, et sans ce commit, la base des
   * corrections par Claude.
   */
  get clonedCommit(): string {
    const repair = this.operation.repair;
    if (!repair) return "HEAD";
    return repair.auditCommit ? `${repair.auditCommit}~1` : repair.base;
  }

  /** Lockfile du projet tel qu'il est dans le commit cloné. */
  async originalLock(project: Project): Promise<Lockfile> {
    return managerOf(project.manager).readLock(await this.git(["show", `${this.clonedCommit}:${lockfilePath(project)}`]), project.path);
  }
}

// --- Étapes -------------------------------------------------------------------

async function cloneStep(runner: Runner): Promise<void> {
  runner.setStep("clone", "running");
  await assertContainersAvailable(runner.containers, runner.cloneDir);
  const operation = runner.operation;
  const [owner, name] = operation.repoId.split("/");
  const workDir = fs.mkdtempSync(path.join(runner.cloneDir, "mcp-dependabot-tracker-"));
  runner.update((current) => ({ ...current, workDir }));
  const url = `${runner.config.serverUrl}/${owner}/${name}.git`;
  await runner.git(
    ["-c", "core.autocrlf=false", "clone", "--depth", "1", "--branch", operation.baseBranch, "--single-branch", "--separate-git-dir", GIT_DIR, url, CLONE_DIR],
    { cwd: workDir, auth: true }
  );
  fs.rmSync(path.join(workDir, CLONE_DIR, ".git"));

  const files = (await runner.git(["ls-files", "-z"])).split("\0");
  const projects = detectProjects(files);
  if (projects.length === 0) {
    const lockfiles = PACKAGE_MANAGERS.map((manager) => manager.lockfile).join(", ");
    throw new TrackerError(`No lockfile is tracked in ${operation.repoId}: the audit needs one of ${lockfiles}.`);
  }
  runner.update((current) => ({ ...current, projects }));
  runner.log(`Projects: ${projects.map((project) => `${projectLabel(project.path) || "./"} (${project.manager})`).join(", ")}`);
  await prepareImages(runner, projects);
  runner.setStep("clone", "done");
}

/** Met à jour, ou construit, une fois chacune, les images des conteneurs des projets. */
async function prepareImages(runner: Runner, projects: Project[]): Promise<void> {
  const ready = new Set<string>();
  for (const project of projects) {
    const image = managerOf(project.manager).image(runner.managers, project.path);
    if (ready.has(image.name)) continue;
    ready.add(image.name);
    if (image.containerfile === undefined) {
      runner.log(`$ podman pull ${image.name}`);
      await pullImage(runner.containers, image.name, runner.cloneDir, runner.signal);
    } else {
      runner.log(`$ podman build --tag ${image.name}`);
      await buildImage(runner.containers, image.name, image.containerfile, runner.signal);
    }
  }
}

/** Audit de chaque projet ; enregistre le total sous `count` et les vulnérabilités restantes. */
async function auditAll(runner: Runner, count: keyof Operation["counts"]): Promise<Vulnerability[]> {
  const vulnerabilities: Vulnerability[] = [];
  const facts: unknown[] = [];
  for (const project of runner.operation.projects) {
    const result = await managerOf(project.manager).audit(runner.managers, project.path);
    vulnerabilities.push(...result.vulnerabilities);
    facts.push(...result.facts);
  }
  runner.facts = facts;
  runner.log(`${vulnerabilities.length} vulnerabilit${vulnerabilities.length === 1 ? "y" : "ies"}`);
  runner.update((operation) => ({
    ...operation,
    counts: { ...operation.counts, [count]: vulnerabilities.length },
    remaining: vulnerabilities,
  }));
  return vulnerabilities;
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

/** Corrections automatiques des projets vulnérables, sans installation ni script de paquet. */
async function fixStep(runner: Runner, vulnerabilities: Vulnerability[]): Promise<Vulnerability[]> {
  runner.setStep("fix", "running");
  for (const project of runner.operation.projects) {
    const found = vulnerabilities.filter((vulnerability) => vulnerability.project === project.path && vulnerability.manager === project.manager);
    if (found.length > 0) await managerOf(project.manager).fix(runner.managers, project.path, found);
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
 * Crée la branche de la correction et y commite les fichiers modifiés par les
 * corrections automatiques, s'ils ont changé ; rend le commit sur lequel
 * reposeront les corrections par Claude, et celui des corrections
 * automatiques, null sans changement.
 */
async function commitAuditFixes(runner: Runner): Promise<{ base: string; auditCommit: string | null }> {
  const branch = runner.operation.branch ?? branchName(new Date());
  runner.update((operation) => ({ ...operation, branch }));
  await runner.git(["checkout", "-b", branch]);
  await runner.git(["add", "-A", ...stagedPaths(runner.operation.projects)]);
  const committed = await hasStagedChanges(runner);
  if (committed) await runner.git([...(await commitIdentity(runner)), "commit", "-m", runner.operation.commitMessage]);
  const base = (await runner.git(["rev-parse", "HEAD"])).trim();
  return { base, auditCommit: committed ? base : null };
}

/** Supprime les fichiers vides non suivis que le bac à sable de Claude Code a créés pour les monter. */
async function removeSandboxPlaceholders(runner: Runner): Promise<void> {
  const untracked = (await runner.git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  for (const file of untracked) {
    if (!SANDBOX_PLACEHOLDERS.has(path.posix.basename(file))) continue;
    const full = path.join(runner.repoDir, file);
    if (fs.lstatSync(full).isFile() && fs.statSync(full).size === 0) fs.rmSync(full);
  }
}

/**
 * Remplace le commit des corrections par Claude par un seul commit de tout ce
 * qui a changé depuis `base` ; rend ce commit, ou null quand rien n'a changé.
 */
async function commitRepair(runner: Runner, base: string, message: string): Promise<string | null> {
  await removeSandboxPlaceholders(runner);
  await runner.git(["reset", "--soft", base]);
  await runner.git(["add", "-A", ...stagedPaths(runner.operation.projects)]);
  if (!(await hasStagedChanges(runner))) return null;
  await runner.git([...(await commitIdentity(runner)), "commit", "-m", message, "-m", CLAUDE_TRAILER]);
  return (await runner.git(["rev-parse", "HEAD"])).trim();
}

/**
 * Corrections par Claude des vulnérabilités restantes : la branche est créée et
 * les corrections automatiques y sont commitées, puis Claude analyse et corrige
 * en une session, dont les changements font un seul commit. Un échec,
 * configuration manquante comprise, remet le clone dans l'état du commit des
 * corrections automatiques et laisse l'opération se poursuivre ; seule une
 * annulation l'interrompt.
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
      containers: ctx.containers,
      managers: [...new Set(operation.projects.map((project) => project.manager))],
      facts: runner.facts,
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
    if (task) runner.log(`Report of Claude ${task.key}: ${task.url}`);
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
    return [`> [!WARNING]`, `> Claude Code could not fix the remaining vulnerabilities: ${repair.error}`, `> This pull request only holds the automatic fixes of the package managers.`, ""];
  }
  if (repair?.report?.tests.outcome === "failed") {
    return [`> [!WARNING]`, `> The tests failed after the fixes by Claude Code: ${repair.report.tests.detail}`, ""];
  }
  return [];
}

function pullRequestBody(operation: Operation): string {
  const after = operation.counts.afterRepair ?? operation.counts.afterFix;
  const repair = operation.repair?.report ? operation.repair : null;
  const managers = PACKAGE_MANAGERS.filter((manager) => operation.projects.some((project) => project.manager === manager.id));
  const commands = managers.map((manager) => `\`${manager.fixCommand(operation.scope)}\``).join(", ");
  const lines = [
    ...pullRequestWarnings(operation),
    `Automated dependency audit fixes, made by mcp-dependabot-tracker in a temporary clone (${commands}).`,
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
    if (repair.report.details) lines.push("<details>", "<summary>Rapport de Claude</summary>", "", repair.report.details, "", "</details>", "");
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
    await runner.git(["add", "-A", ...stagedPaths(runner.operation.projects)]);
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
    const runner = new Runner(ctx, id, controller.signal, ctx.githubConfig(), ctx.cloneDir(), ctx.containers);
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
 * arrière-plan jusqu'au bout sans intervention : clone, audit, corrections automatiques,
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
 * `origin` et mené en arrière-plan : clone et audit, sans rien modifier.
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
 * Audit de la branche que `branch` choisit parmi celles du dépôt, sur le
 * périmètre `scope`, lancé par l'utilisateur et attendu jusqu'à sa fin. Refusé
 * si une opération est en cours sur le dépôt, ou s'il est déprécié.
 */
async function runUserAudit(ctx: OperationContext, repoId: string, scope: AuditScope, branch: (repo: Repo) => string): Promise<Operation> {
  ctx.githubConfig();
  const repo = ctx.store.getRepo(repoId);
  assertNotDeprecated(repo);
  const operation = ctx.store.createOperation({ ...newOperation(repo, "audit", "user", scope), baseBranch: branch(repo) });
  return execute(ctx, operation.id, async (runner) => {
    await cloneStep(runner);
    await auditStep(runner);
    finish(runner);
  });
}

/**
 * Audit de la branche analysée, sur le périmètre `scope`, lancé par
 * l'utilisateur et attendu jusqu'à sa fin. Refusé si une opération est en
 * cours sur le dépôt, ou s'il est déprécié.
 */
export function runAudit(ctx: OperationContext, repoId: string, scope: AuditScope): Promise<Operation> {
  return runUserAudit(ctx, repoId, scope, (repo) => repo.branch);
}

/**
 * Audit de la branche par défaut, celle que Dependabot analyse, sur le
 * périmètre `scope`, lancé par l'utilisateur et attendu jusqu'à sa fin. Refusé
 * si une opération est en cours sur le dépôt, ou s'il est déprécié.
 */
export function runDefaultBranchAudit(ctx: OperationContext, repoId: string, scope: AuditScope): Promise<Operation> {
  return runUserAudit(ctx, repoId, scope, (repo) => repo.defaultBranch);
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
