import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import type { RemarksResponse } from "../../shared/schemas/api.schema.js";
import { RepairReportSchema, TEST_OUTCOMES, type AnalysisTask, type AuditScope, type Operation, type RepairReport, type SessionEvent } from "../../shared/schemas/model.schema.js";
import type { Settings } from "../../shared/schemas/settings.schema.js";
import { ORGANIZER_SERVER, factsJson, organizerServer } from "./analysis.js";
import { runClaudeSession, type ClaudeRuntime } from "./claude.js";
import { tail } from "./commands.js";
import { TrackerError } from "./errors.js";
import { OrganizerClient } from "./organizer.js";
import { organizerConnection } from "./settings.js";

/**
 * Corrections par Claude des vulnérabilités que `npm audit fix` laisse dans un
 * clone, d'après la tâche de l'analyse et les commentaires que l'utilisateur y
 * a laissés. Claude modifie le clone (Read, Grep, Glob, Edit, Write), sans git
 * ni écriture hors du clone, et lance les commandes npm (lockfile, audit,
 * installation, tests) par les outils du serveur `npm-tools`, que le tracker
 * exécute dans son propre bac à sable, sans aucun token. Il crée
 * une sous-tâche « rapport de développement » de la tâche de l'analyse, ou met
 * à jour celle d'un passage précédent, puis rend un rapport structuré. Le
 * tracker relit la sous-tâche sur l'organizer : absente, rattachée à une autre
 * tâche, mal assignée ou mal taguée, elle fait échouer les corrections.
 */

/** Outils organizer autorisés ; tout autre appel est refusé par `dontAsk`. */
const ORGANIZER_TOOLS = ["get_task", "create_task", "update_task", "set_assignees", "set_tags"];

/** Serveur MCP des commandes npm, dans la configuration de la session. */
const NPM_SERVER = "npm";

/** Outils du serveur `npm-tools`. */
const NPM_TOOLS = ["npm_install_lockfile", "npm_audit", "npm_ci", "npm_test", "npm_run", "npm_ls", "tsc"];

/** Réglages de la session : Edit et Write refusent tout chemin hors du clone. */
const SESSION_SETTINGS = { permissions: { blockWritesOutsideWorkingDirectories: true } };

/** Lancement du serveur `npm-tools` du tracker sur le clone et le cache npm de l'opération. */
function npmServer(input: RepairInput, cache: string) {
  const entry = fileURLToPath(new URL("../npm-tools.js", import.meta.url));
  return { command: process.execPath, args: [entry, "--root", input.cwd, "--cache", cache, "--scope", input.scope] };
}

/** Bac à sable minimal, du type de ceux où le tracker lance les commandes npm sous Linux. */
const BWRAP_PROBE = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-user", "--unshare-pid", "--unshare-net", "true"];

/** Durée maximale du test de bubblewrap. */
const BWRAP_PROBE_TIMEOUT_MS = 10_000;

/**
 * Vérifie, sous Linux, que bubblewrap crée un bac à sable pour le compte et
 * avec les restrictions du serveur : le tracker s'en sert pour lancer les
 * commandes npm de Claude, et Claude Code refuse de démarrer sans lui. Lève une erreur qui
 * dit quoi installer ou régler ; sans effet sur les autres systèmes.
 */
export function assertSandboxAvailable(platform: NodeJS.Platform = process.platform, command = "bwrap"): Promise<void> {
  if (platform !== "linux") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn(command, BWRAP_PROBE, { stdio: ["ignore", "ignore", "pipe"], timeout: BWRAP_PROBE_TIMEOUT_MS });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (err: any) =>
      reject(
        new TrackerError(
          err.code === "ENOENT"
            ? "The fixes by Claude need bubblewrap (bwrap), which isolates the npm commands of Claude on Linux, and it is not in the PATH of the MCP server. Install it on the server: sudo apt-get install -y bubblewrap socat"
            : `The fixes by Claude need bubblewrap (bwrap), which could not be started: ${err.message}`
        )
      )
    );
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new TrackerError(
          `bubblewrap (bwrap) is installed but cannot create a sandbox for the account of the MCP server${stderr.trim() ? `: ${tail(stderr, 3)}` : "."} ` +
            "Check the AppArmor restriction on user namespaces (kernel.apparmor_restrict_unprivileged_userns on Ubuntu 24.04 and later) and the hardening of the service (RestrictNamespaces, PrivateUsers, SystemCallFilter)."
        )
      );
    });
  });
}

/** Résultat demandé à Claude : le rapport et la clé de la sous-tâche. */
const OutputSchema = RepairReportSchema.extend({ task: z.string().min(1), commitMessage: z.string().trim().min(1) });

const OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["task", "summary", "changes", "commitMessage", "tests"],
  properties: {
    task: { type: "string", description: "Key of the development report sub-task, e.g. ORG-43." },
    summary: { type: "string", description: "One or two sentences, in French." },
    changes: {
      type: "array",
      description: "Every file you changed; empty when none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "change"],
        properties: { file: { type: "string", description: "Path relative to the repository root." }, change: { type: "string", description: "A few words, in French." } },
      },
    },
    commitMessage: { type: "string", description: "Conventional commit message in English, first line under 72 characters." },
    tests: {
      type: "object",
      additionalProperties: false,
      required: ["outcome", "detail"],
      properties: { outcome: { type: "string", enum: [...TEST_OUTCOMES] }, detail: { type: "string", description: "One sentence, in French." } },
    },
  },
};

export interface RepairInput {
  repoId: string;
  branch: string;
  scope: AuditScope;
  /** Clone du dépôt : dossier de travail de Claude. */
  cwd: string;
  /** Dossier de l'opération, hors du clone : configuration MCP de la session. */
  workDir: string;
  /** Vulnérabilités restantes, d'après `npm audit --json`. */
  facts: unknown[];
  forceApplied: boolean;
  /** Clé de la tâche de l'analyse, dont les commentaires portent les remarques de l'utilisateur. */
  analysisTask: string;
  /** Clé de la sous-tâche d'un passage précédent, dont le clone contient encore les corrections. */
  reportTask: string | null;
  settings: Settings;
  claude: ClaudeRuntime;
  signal: AbortSignal;
  onEvent: (event: SessionEvent, turns: number) => void;
}

function prompt(input: RepairInput, space: string, owner: { id: string; name: string }, tag: string): string {
  const fixes = input.forceApplied ? "`npm audit fix` and `npm audit fix --force`" : "`npm audit fix`";
  const omit = input.scope === "production" ? " --omit=dev" : "";
  const report = input.reportTask
    ? `update the description of your previous report, task ${input.reportTask}, with update_task (keep it a sub-task of ${input.analysisTask}); do not create a new one.`
    : `create one sub-task of ${input.analysisTask} with create_task (parent "${input.analysisTask}"), without request_id, titled in French "Rapport de développement — " followed by what you changed.`;
  return [
    `You fix the npm vulnerabilities that ${fixes} left in the GitHub repository ${input.repoId} (branch ${input.branch}).`,
    input.scope === "production"
      ? "The audit covers the production dependencies only (`--omit=dev`): the vulnerabilities of the devDependencies are out of scope."
      : "The audit covers all the dependencies, devDependencies included.",
    `The current directory is a clone of that branch where ${fixes} already updated the lockfiles.`,
    ...(input.reportTask ? [`It also holds the changes of your previous pass, described in task ${input.reportTask}: build on them, and change or revert them where the remarks of the user ask for it.`] : []),
    "",
    "Remaining vulnerabilities, from `npm audit --json` (`project` is the folder of the package-lock.json):",
    "```json",
    factsJson(input.facts),
    "```",
    "",
    "Your job:",
    `1. Read the organizer task ${input.analysisTask} with get_task: its description is the analysis of these vulnerabilities, and its comments are the remarks of the user. Follow the remarks: they take precedence over the analysis.`,
    `2. Fix what can be fixed, with minimal changes: upgrade a dependency in package.json, or pin a transitive one with an \`overrides\` entry, with Edit, then update the lockfile with the ${NPM_SERVER} tool npm_install_lockfile in the folder of the package-lock.json; adapt the code to the new versions.`,
    `3. Check your work with the ${NPM_SERVER} tools, the only way to run npm here: npm_audit${omit ? " (it runs `npm audit" + omit + "`)" : ""} in each project; npm_ci to install the dependencies, then npm_test (or npm_run with the test script of package.json) when the project has some; npm_ls and tsc when useful. Their \`project\` argument is the folder of the package.json, "" for the root.`,
    "   You have no shell. Never write outside the current directory: the tracker commits your changes, node_modules aside.",
    "   If a command fails, quote its exact error, with the path it names, in your report.",
    `4. Report in the organizer space "${space}": ${report} Its description, in French markdown, details every change file by file and why, how each remark of the user was taken into account, the result of the audit and of the tests, and what is left to check by hand.`,
    `   Assign it to ${owner.name} with set_assignees (member id ${owner.id}), and set its tags to exactly ["${tag}"] with set_tags.`,
    "5. Finish with the structured report: the key of the sub-task, a summary in French, every changed file with its change in a few words in French, a conventional commit message in English for your changes, and the outcome of the tests with a one-sentence detail in French.",
  ].join("\n");
}

/** Tâche de l'analyse d'une opération et ses commentaires : les remarques que Claude prendra en compte. */
export async function analysisRemarks(settings: Settings, operation: Operation): Promise<RemarksResponse> {
  const connection = organizerConnection(settings);
  const task = operation.analysis?.task;
  if (!connection) throw new TrackerError("The organizer connection is not set: set it in the settings.");
  if (!task) throw new TrackerError(`Operation ${operation.id} has no organizer task from an analysis.`);
  const { comments } = await new OrganizerClient(connection).taskWithComments(task.key);
  return { task, remarks: comments };
}

/** Lance les corrections, puis vérifie sur l'organizer la sous-tâche que Claude dit avoir créée ou mise à jour. */
export async function repairVulnerabilities(input: RepairInput): Promise<{ report: RepairReport; task: AnalysisTask }> {
  const connection = organizerConnection(input.settings);
  const token = input.settings.claude.token;
  if (!connection || !token) throw new TrackerError("The fixes by Claude need the organizer connection and the Claude token: set them in the settings.");
  const organizer = new OrganizerClient(connection);
  const { space, owner } = await organizer.space();
  const tag = input.repoId.split("/")[1];

  const configFile = path.join(input.workDir, "repair-mcp.json");
  const servers = { [ORGANIZER_SERVER]: organizerServer(connection), [NPM_SERVER]: npmServer(input, path.join(input.workDir, "npm-cache")) };
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: servers }), { encoding: "utf-8", mode: 0o600 });
  let structured: unknown;
  try {
    ({ structured } = await runClaudeSession(input.claude, {
      cwd: input.cwd,
      prompt: prompt(input, space.name, owner, tag),
      args: [
        "--tools",
        "Read,Grep,Glob,Edit,Write",
        "--allowedTools",
        ["Edit", "Write", ...NPM_TOOLS.map((tool) => `mcp__${NPM_SERVER}__${tool}`), ...ORGANIZER_TOOLS.map((tool) => `mcp__${ORGANIZER_SERVER}__${tool}`)].join(","),
        "--settings",
        JSON.stringify(SESSION_SETTINGS),
        "--mcp-config",
        configFile,
        "--strict-mcp-config",
        "--json-schema",
        JSON.stringify(OUTPUT_JSON_SCHEMA),
      ],
      env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" },
      token,
      maxTurns: input.settings.analysis.maxTurns,
      maxMinutes: input.settings.analysis.maxMinutes,
      signal: input.signal,
      onEvent: input.onEvent,
    }));
  } finally {
    fs.rmSync(configFile, { force: true });
  }

  const output = OutputSchema.safeParse(structured);
  if (!output.success) throw new TrackerError("Claude Code ended without the structured report of its fixes.");
  const task = await organizer.task(output.data.task);
  if (task.parentKey?.toLowerCase() !== input.analysisTask.toLowerCase()) {
    throw new TrackerError(`Task ${task.key} is not a sub-task of ${input.analysisTask}.`);
  }
  if (!task.tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase())) {
    throw new TrackerError(`Task ${task.key} was created without the tag "${tag}".`);
  }
  if (!task.assigneeIds.includes(owner.id)) {
    throw new TrackerError(`Task ${task.key} was created without being assigned to ${owner.name}.`);
  }
  const { task: _key, ...report } = output.data;
  return { report, task: { key: task.key, title: task.title, url: organizer.taskUrl(task.id), status: task.status } };
}
