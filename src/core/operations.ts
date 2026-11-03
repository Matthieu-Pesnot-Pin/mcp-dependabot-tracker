import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  DEFAULT_COMMIT_MESSAGE,
  type AuditScope,
  type ClaudeSession,
  type Change,
  type Operation,
  type OperationKind,
  type Origin,
  type PullRequest,
  type Repair,
  type Repo,
  type SessionKind,
  type SessionOutcome,
  type StepName,
  type StepState,
} from "../../shared/schemas/model.schema.js";
import type { Settings } from "../../shared/schemas/settings.schema.js";
import { analyseVulnerabilities, auditFacts } from "./analysis.js";
import { activityLine, type ClaudeRuntime } from "./claude.js";
import { CommandAbortedError, runCommand, tail, type CommandResult } from "./commands.js";
import type { GitHubConfig } from "./config.js";
import { ConflictError, TrackerError } from "./errors.js";
import { GitHubClient } from "./github.js";
import {
  diffLockfiles,
  forceCandidates,
  parseAuditReport,
  parseLockfile,
  parseNpmJson,
  projectLabel,
  type AuditedVulnerability,
  type Lockfile,
} from "./npm-audit.js";
import { analysisRemarks, assertSandboxAvailable, repairVulnerabilities } from "./repair.js";
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
  /** Réglages de l'analyse par Claude, relus à chaque correction. */
  settings: () => Settings;
  /** Commande et dossier de configuration de Claude Code. */
  claude: ClaudeRuntime;
}

/** Choix de l'agent pour une opération qu'il mène d'un bout à l'autre. */
export interface AgentPlan {
  scope: AuditScope;
  force: boolean;
  push: boolean;
  commitMessage: string;
}

/** Intervalle de lecture de la demande d'annulation pendant une étape. */
const CANCEL_POLL_MS = 500;

const MAX_LOG_ENTRIES = 300;
const MAX_LOG_TEXT = 4000;

/** Dossier du clone dans le répertoire temporaire de l'opération. */
const CLONE_DIR = "repo";

/** Paquets listés dans le corps de la pull request. */
const MAX_PR_CHANGES = 60;

/** Dernières actions de Claude gardées dans l'opération pendant l'analyse et les corrections. */
const ANALYSIS_ACTIVITY = 3;

/** Éléments du déroulé gardés par session de Claude, les plus récents. */
const SESSION_EVENTS = 500;

function newSession(kind: SessionKind, run: number, tasks: ClaudeSession["tasks"]): ClaudeSession {
  return {
    kind,
    run,
    startedAt: now(),
    endedAt: null,
    turns: 0,
    outcome: "running",
    error: null,
    remarks: [],
    tasks,
    events: [],
    analysisReport: null,
    repairReport: null,
    commit: null,
    remaining: null,
  };
}

/** Sessions de l'opération, la dernière transformée par `fn`. */
function withLastSession(operation: Operation, fn: (session: ClaudeSession) => ClaudeSession): ClaudeSession[] {
  return operation.sessions.map((session, index) => (index === operation.sessions.length - 1 ? fn(session) : session));
}

/** Termine la dernière session : réussie, échouée avec sa raison, ou annulée. */
function endSession(runner: Runner, outcome: SessionOutcome, changes: Partial<ClaudeSession> = {}): void {
  runner.update((operation) => ({ ...operation, sessions: withLastSession(operation, (session) => ({ ...session, ...changes, outcome, endedAt: now() })) }));
}

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
    pid: process.pid,
    workDir: null,
    baseBranch: repo.branch,
    cancelRequested: false,
    steps: { clone: "pending", audit: "pending", fix: "pending", analysis: "pending", force: "pending", repair: "pending", push: "pending" },
    projects: [],
    counts: { initial: null, afterFix: null, afterForce: null, afterRepair: null },
    found: [],
    remaining: [],
    forceCandidates: [],
    changes: [],
    commitMessage: DEFAULT_COMMIT_MESSAGE,
    branch: null,
    pullRequest: null,
    analysis: null,
    repair: null,
    sessions: [],
    error: null,
    log: [],
  };
}

/** Exécution des étapes d'une opération, avec son signal d'annulation. */
class Runner {
  /** Dernier rapport `npm audit --json` de chaque projet, lu par l'analyse. */
  readonly auditReports = new Map<string, any>();

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
async function auditAll(runner: Runner, count: keyof Operation["counts"]): Promise<AuditedVulnerability[]> {
  const vulnerabilities: AuditedVulnerability[] = [];
  for (const project of runner.operation.projects) {
    const report = await runner.npm(project, ["audit", ...scopeArgs(runner.operation.scope), "--json"]);
    runner.auditReports.set(project, report);
    vulnerabilities.push(...parseAuditReport(report, project));
  }
  runner.log(`${vulnerabilities.length} vulnerabilit${vulnerabilities.length === 1 ? "y" : "ies"}`);
  runner.update((operation) => ({
    ...operation,
    counts: { ...operation.counts, [count]: vulnerabilities.length },
    remaining: vulnerabilities.map(({ project, name, severity, fix }) => ({ project, name, severity, fix })),
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

async function auditStep(runner: Runner): Promise<AuditedVulnerability[]> {
  runner.setStep("audit", "running");
  const vulnerabilities = await auditAll(runner, "initial");
  runner.update((operation) => ({ ...operation, found: operation.remaining }));
  runner.setStep("audit", "done");
  return vulnerabilities;
}

/** `npm audit fix` dans les projets vulnérables, sans installer node_modules ni lancer de scripts. */
async function fixStep(runner: Runner, vulnerabilities: AuditedVulnerability[]): Promise<AuditedVulnerability[]> {
  runner.setStep("fix", "running");
  const projects = new Set(vulnerabilities.map((vulnerability) => vulnerability.project));
  for (const project of runner.operation.projects.filter((candidate) => projects.has(candidate))) {
    await runner.npm(project, ["audit", "fix", ...scopeArgs(runner.operation.scope), "--package-lock-only", "--ignore-scripts", "--json"]);
  }
  const remaining = await auditAll(runner, "afterFix");
  await refreshChanges(runner);
  const locks = Object.fromEntries(runner.operation.projects.map((project) => [project, runner.readLock(project)]));
  runner.update((operation) => ({ ...operation, forceCandidates: forceCandidates(remaining, locks) }));
  runner.setStep("fix", "done");
  return remaining;
}

/**
 * Analyse par Claude des vulnérabilités restantes, quand l'analyse automatique
 * est activée ; passée sinon, ou s'il ne reste rien. Son échec est enregistré
 * dans l'analyse et laisse l'opération se poursuivre ; seule une annulation
 * l'interrompt.
 */
async function analysisStep(runner: Runner, ctx: OperationContext): Promise<void> {
  const settings = ctx.settings();
  if (!settings.analysis.auto || runner.operation.remaining.length === 0) {
    runner.setStep("analysis", "skipped");
    return;
  }
  runner.setStep("analysis", "running");
  runner.update((operation) => ({
    ...operation,
    analysis: { startedAt: now(), endedAt: null, turns: 0, activity: [], report: null, task: null, error: null },
    sessions: [...operation.sessions, newSession("analysis", 1, [])],
  }));
  const analysed = (fn: (analysis: NonNullable<Operation["analysis"]>) => NonNullable<Operation["analysis"]>) =>
    runner.update((operation) => ({ ...operation, analysis: operation.analysis && fn(operation.analysis) }));

  try {
    const operation = runner.operation;
    const { report, task } = await analyseVulnerabilities({
      repoId: operation.repoId,
      branch: operation.baseBranch,
      scope: operation.scope,
      cwd: runner.repoDir,
      workDir: operation.workDir!,
      facts: operation.projects.flatMap((project) => auditFacts(runner.auditReports.get(project), project)),
      forceCandidates: operation.forceCandidates,
      settings,
      claude: ctx.claude,
      signal: runner.signal,
      onEvent: (event, turns) => {
        const line = activityLine(event);
        runner.log(`claude: ${line}`);
        runner.update((current) => ({
          ...current,
          analysis: current.analysis && { ...current.analysis, turns, activity: [...current.analysis.activity, line].slice(-ANALYSIS_ACTIVITY) },
          sessions: withLastSession(current, (session) => ({ ...session, turns, events: [...session.events, event].slice(-SESSION_EVENTS) })),
        }));
      },
    });
    runner.log(`Organizer task ${task.key}: ${task.url}`);
    analysed((analysis) => ({ ...analysis, endedAt: now(), report, task }));
    endSession(runner, "done", { tasks: [{ task, role: "created" }], analysisReport: report });
    runner.setStep("analysis", "done");
  } catch (err: any) {
    if (err instanceof CommandAbortedError || runner.signal.aborted) {
      endSession(runner, "cancelled");
      throw err;
    }
    const message = err?.message ?? String(err);
    runner.log(`Analysis failed: ${message}`);
    analysed((analysis) => ({ ...analysis, endedAt: now(), error: message }));
    endSession(runner, "failed", { error: message });
    runner.setStep("analysis", "failed");
  }
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

/** `npm audit fix --force` dans les projets qui ont une montée majeure à appliquer. */
async function forceStep(runner: Runner): Promise<void> {
  runner.setStep("force", "running");
  const projects = new Set(runner.operation.forceCandidates.map((candidate) => candidate.project));
  for (const project of runner.operation.projects.filter((candidate) => projects.has(candidate))) {
    await runner.npm(project, ["audit", "fix", "--force", ...scopeArgs(runner.operation.scope), "--package-lock-only", "--ignore-scripts", "--json"]);
  }
  await auditAll(runner, "afterForce");
  await refreshChanges(runner);
  runner.setStep("force", "done");
}

/**
 * Corrections par Claude, d'après la tâche de l'analyse et les remarques de
 * l'utilisateur : la première fois, la branche est créée et `npm audit fix`
 * y est commité ; les corrections de Claude font ensuite un seul commit, qui
 * remplace celui d'un passage précédent. Un échec remet le clone dans l'état
 * du passage précédent et garde ses résultats ; seule une annulation
 * interrompt l'opération.
 */
async function repairStep(runner: Runner, ctx: OperationContext): Promise<void> {
  runner.setStep("repair", "running");
  const previous = runner.operation.repair;
  const { base, auditCommit } = previous ?? (await commitAuditFixes(runner));
  const repair: Repair = {
    runs: (previous?.runs ?? 0) + 1,
    startedAt: now(),
    endedAt: null,
    turns: 0,
    activity: [],
    base,
    auditCommit,
    commit: previous?.commit ?? null,
    report: previous?.report ?? null,
    task: previous?.task ?? null,
    error: null,
  };
  const analysisTask = runner.operation.analysis?.task ?? null;
  runner.update((operation) => ({
    ...operation,
    repair,
    sessions: [...operation.sessions, newSession("repair", repair.runs, analysisTask ? [{ task: analysisTask, role: "read" }] : [])],
  }));
  const repaired = (fn: (current: Repair) => Repair) => runner.update((operation) => ({ ...operation, repair: operation.repair && fn(operation.repair) }));

  try {
    if (!analysisTask) throw new TrackerError("The fixes by Claude need the organizer task of the analysis.");
    const { remarks } = await analysisRemarks(ctx.settings(), runner.operation);
    runner.update((current) => ({ ...current, sessions: withLastSession(current, (session) => ({ ...session, remarks })) }));
    const operation = runner.operation;
    const { report, task } = await repairVulnerabilities({
      repoId: operation.repoId,
      branch: operation.baseBranch,
      scope: operation.scope,
      cwd: runner.repoDir,
      workDir: operation.workDir!,
      facts: await currentAuditFacts(runner),
      forceApplied: operation.steps.force === "done",
      analysisTask: analysisTask.key,
      reportTask: previous?.task?.key ?? null,
      settings: ctx.settings(),
      claude: ctx.claude,
      signal: runner.signal,
      onEvent: (event, turns) => {
        const line = activityLine(event);
        runner.log(`claude: ${line}`);
        runner.update((current) => ({
          ...current,
          repair: current.repair && { ...current.repair, turns, activity: [...current.repair.activity, line].slice(-ANALYSIS_ACTIVITY) },
          sessions: withLastSession(current, (session) => ({ ...session, turns, events: [...session.events, event].slice(-SESSION_EVENTS) })),
        }));
      },
    });
    const commit = await commitRepair(runner, base, report.commitMessage);
    runner.log(`Development report ${task.key}: ${task.url}`);
    await auditAll(runner, "afterRepair");
    await refreshChanges(runner);
    repaired((current) => ({ ...current, endedAt: now(), commit, report, task }));
    endSession(runner, "done", {
      tasks: [{ task: analysisTask, role: "read" }, { task, role: previous?.task ? "updated" : "created" }],
      repairReport: report,
      commit,
      remaining: runner.operation.counts.afterRepair,
    });
    runner.setStep("repair", "done");
  } catch (err: any) {
    if (err instanceof CommandAbortedError || runner.signal.aborted) {
      endSession(runner, "cancelled");
      throw err;
    }
    const message = err?.message ?? String(err);
    runner.log(`Fixes by Claude failed: ${message}`);
    await runner.git(["reset", "--hard", "HEAD"]);
    await runner.git(["clean", "-fd", "-e", "node_modules"]);
    repaired((current) => ({ ...current, endedAt: now(), error: message }));
    endSession(runner, "failed", { error: message });
    runner.setStep("repair", previous?.report ? "done" : "failed");
  }
}

function pullRequestBody(operation: Operation): string {
  const after = operation.counts.afterRepair ?? operation.counts.afterForce ?? operation.counts.afterFix;
  const repair = operation.repair?.report ? operation.repair : null;
  const command = ["npm audit fix", ...scopeArgs(operation.scope), "--package-lock-only --ignore-scripts"].join(" ");
  const lines = [
    `Automated \`npm audit\` fixes, made by mcp-dependabot-tracker in a temporary clone (\`${command}\`).`,
    "",
    operation.scope === "production"
      ? "- Scope: production dependencies only; the vulnerabilities of the devDependencies were neither audited nor fixed."
      : "- Scope: all dependencies, devDependencies included.",
    `- Vulnerabilities before: ${operation.counts.initial}`,
    `- Vulnerabilities after: ${after}`,
    `- \`npm audit fix --force\`: ${operation.steps.force === "done" ? "applied" : "not applied"}`,
    ...(operation.analysis?.task ? [`- Remaining vulnerabilities analysed by Claude: organizer task ${operation.analysis.task.key}`] : []),
    "",
    `Updated packages (${operation.changes.length}):`,
    "",
  ];
  for (const change of operation.changes.slice(0, MAX_PR_CHANGES)) {
    lines.push(`- \`${projectLabel(change.project)}${change.name}\` ${change.from ?? "(added)"} → ${change.to ?? "(removed)"}`);
  }
  if (operation.changes.length > MAX_PR_CHANGES) lines.push(`- … and ${operation.changes.length - MAX_PR_CHANGES} more`);
  if (repair?.report) {
    lines.push("", `Fixes by Claude Code${repair.task ? `, detailed in organizer task ${repair.task.key}` : ""}:`, "", repair.report.summary, "");
    for (const change of repair.report.changes) lines.push(`- \`${change.file}\`: ${change.change}`);
    lines.push(`- Tests: ${repair.report.tests.outcome.replace("_", " ")} — ${repair.report.tests.detail}`);
  }
  return lines.join("\n");
}

/**
 * Commit des lockfiles modifiés sur une nouvelle branche, push, puis pull
 * request vers la branche analysée. Après des corrections par Claude, la
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

/**
 * Après les corrections : la suite attend l'utilisateur, avec le nom de la
 * branche qui sera poussée, ou l'opération se termine s'il n'y a rien à pousser.
 */
function settleForPush(runner: Runner): void {
  const operation = runner.operation;
  if (operation.changes.length > 0 || operation.repair?.auditCommit || operation.repair?.commit) {
    runner.update((current) => ({ ...current, status: "waiting_push", branch: current.branch ?? branchName(new Date()) }));
  } else {
    finish(runner);
  }
}

/** Vrai quand Claude peut corriger : son analyse a créé une tâche et des vulnérabilités restent. */
function canRepair(operation: Operation): boolean {
  return operation.analysis?.task != null && operation.remaining.length > 0;
}

/** Après `npm audit fix` et la décision sur `--force` : les corrections par Claude attendent l'utilisateur quand elles sont possibles, sinon le push. */
function settleAfterFixes(runner: Runner): void {
  if (canRepair(runner.operation)) {
    runner.update((operation) => ({ ...operation, status: "waiting_repair" }));
    return;
  }
  runner.setStep("repair", "skipped");
  settleForPush(runner);
}

/** Après un passage de Claude : le push attend quand un passage a abouti, sinon les corrections attendent de nouveau. */
function settleAfterRepair(runner: Runner): void {
  if (runner.operation.repair?.report) {
    settleForPush(runner);
  } else {
    runner.update((operation) => ({ ...operation, status: "waiting_repair" }));
  }
}

/**
 * Exécute `body` pour l'opération `id`, avec un signal déclenché par une demande
 * d'annulation enregistrée par n'importe quel processus. Une erreur fait échouer
 * l'opération et l'étape en cours ; une opération terminée perd son clone.
 */
async function execute(ctx: OperationContext, id: string, body: (runner: Runner) => Promise<void>): Promise<Operation> {
  const controller = new AbortController();
  const watcher = setInterval(() => {
    try {
      if (ctx.store.getOperation(id).cancelRequested) controller.abort();
    } catch {
      // Lecture concurrente ou verrou occupé : la demande est relue au tour suivant.
    }
  }, CANCEL_POLL_MS);

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
    clearInterval(watcher);
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

/** Passe une opération en attente à `running` dans ce processus ; refusé si elle n'attend pas `expected`. */
function resume(ctx: OperationContext, id: string, expected: Operation["status"], fn: (operation: Operation) => Operation): Operation {
  return ctx.store.updateOperation(id, (operation) => {
    if (operation.status !== expected) {
      throw new ConflictError(`Operation ${id} is ${operation.status}, not ${expected}.`);
    }
    return fn({ ...operation, status: "running", pid: process.pid });
  });
}

/** Laisse une exécution se poursuivre en arrière-plan ; une erreur imprévue est journalisée. */
function inBackground(ctx: OperationContext, id: string, run: Promise<Operation>): void {
  run.catch((err: any) => ctx.logError(`Operation ${id} could not be recorded: ${err?.stack ?? err}`));
}

// --- Entrées ---------------------------------------------------------------------

/**
 * Lance une correction depuis la GUI, sur le périmètre `scope` : clone, audit,
 * `npm audit fix` et l'analyse par Claude s'exécutent en arrière-plan, puis
 * l'opération attend la décision sur `--force`, les corrections par Claude ou
 * le push. Refusé sur un dépôt déprécié.
 */
export function startUserFix(ctx: OperationContext, repoId: string, scope: AuditScope): Operation {
  ctx.githubConfig();
  const repo = ctx.store.getRepo(repoId);
  assertNotDeprecated(repo);
  const operation = ctx.store.createOperation(newOperation(repo, "fix", "user", scope));
  inBackground(
    ctx,
    operation.id,
    execute(ctx, operation.id, async (runner) => {
      await cloneStep(runner);
      const vulnerabilities = await auditStep(runner);
      if (vulnerabilities.length === 0) return finish(runner);
      await fixStep(runner, vulnerabilities);
      await analysisStep(runner, ctx);
      if (runner.operation.forceCandidates.length > 0) {
        runner.update((current) => ({ ...current, status: "waiting_force" }));
        return;
      }
      runner.setStep("force", "skipped");
      settleAfterFixes(runner);
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

/** Applique ou passe `npm audit fix --force` sur une opération qui attend cette décision. */
export function decideForce(ctx: OperationContext, id: string, apply: boolean): Operation {
  const operation = resume(ctx, id, "waiting_force", (current) => current);
  inBackground(
    ctx,
    id,
    execute(ctx, id, async (runner) => {
      if (apply) {
        await forceStep(runner);
      } else {
        runner.setStep("force", "skipped");
      }
      settleAfterFixes(runner);
    })
  );
  return operation;
}

/**
 * Lance ou passe les corrections par Claude d'une opération qui les attend ;
 * `run` sur une opération qui attend le push après un passage relance Claude
 * avec les remarques de l'utilisateur. Un lancement est refusé tant que le
 * bac à sable de Claude Code ne peut pas démarrer sur le serveur.
 */
export async function decideRepair(ctx: OperationContext, id: string, run: boolean): Promise<Operation> {
  if (run) await assertSandboxAvailable();
  const relaunch = run && ctx.store.getOperation(id).status === "waiting_push";
  const operation = resume(ctx, id, relaunch ? "waiting_push" : "waiting_repair", (current) => {
    if (relaunch && !current.repair?.report) throw new ConflictError(`Operation ${id} has no fixes by Claude to run again.`);
    return current;
  });
  inBackground(
    ctx,
    id,
    execute(ctx, id, async (runner) => {
      if (!run) {
        runner.setStep("repair", "skipped");
        settleForPush(runner);
        return;
      }
      await repairStep(runner, ctx);
      settleAfterRepair(runner);
    })
  );
  return operation;
}

/** Commit, push et pull request d'une opération qui attend le push. */
export function pushOperation(ctx: OperationContext, id: string, commitMessage: string): Operation {
  const operation = resume(ctx, id, "waiting_push", (current) => ({ ...current, commitMessage }));
  inBackground(
    ctx,
    id,
    execute(ctx, id, async (runner) => {
      await pushStep(runner);
      finish(runner);
    })
  );
  return operation;
}

/**
 * Annule une opération : une opération en attente se termine aussitôt ; une
 * opération en cours reçoit une demande d'annulation, lue par le processus qui
 * l'exécute, qui arrête sa commande.
 */
export function cancelOperation(ctx: OperationContext, id: string): Operation {
  ctx.store.failOrphanedOperations();
  const operation = ctx.store.updateOperation(id, (current) => {
    if (!isActive(current)) throw new ConflictError(`Operation ${id} is already ${current.status}.`);
    if (current.status === "running") return { ...current, cancelRequested: true };
    return {
      ...current,
      status: "cancelled",
      steps: Object.fromEntries(
        Object.entries(current.steps).map(([step, state]) => [step, state === "pending" ? "skipped" : state])
      ) as Operation["steps"],
    };
  });
  return cleanUp(ctx, operation.id);
}

/**
 * Opération menée par l'agent d'un bout à l'autre, sur le périmètre de `plan`,
 * attendue jusqu'à sa fin : `audit` s'arrête après `npm audit` ; `fix` enchaîne
 * `npm audit fix`, puis `--force` et le push selon `plan`. Refusé sur un dépôt
 * déprécié.
 */
export async function runAgentOperation(ctx: OperationContext, repoId: string, kind: OperationKind, plan: AgentPlan): Promise<Operation> {
  ctx.githubConfig();
  const repo = ctx.store.getRepo(repoId);
  assertNotDeprecated(repo);
  const operation = ctx.store.createOperation({ ...newOperation(repo, kind, "agent", plan.scope), commitMessage: plan.commitMessage });
  return execute(ctx, operation.id, async (runner) => {
    await cloneStep(runner);
    const vulnerabilities = await auditStep(runner);
    if (kind === "audit" || vulnerabilities.length === 0) return finish(runner);
    await fixStep(runner, vulnerabilities);
    runner.setStep("analysis", "skipped");
    if (plan.force && runner.operation.forceCandidates.length > 0) {
      await forceStep(runner);
    } else {
      runner.setStep("force", "skipped");
    }
    if (plan.push && runner.operation.changes.length > 0) await pushStep(runner);
    finish(runner);
  });
}
