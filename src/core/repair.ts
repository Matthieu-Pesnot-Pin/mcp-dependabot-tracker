import fs from "fs";
import path from "path";
import { z } from "zod";
import type { RemarksResponse } from "../../shared/schemas/api.schema.js";
import { RepairReportSchema, TEST_OUTCOMES, type AnalysisTask, type AuditScope, type Operation, type RepairReport } from "../../shared/schemas/model.schema.js";
import type { Settings } from "../../shared/schemas/settings.schema.js";
import { ORGANIZER_SERVER, factsJson, organizerServer } from "./analysis.js";
import { runClaudeSession, type ClaudeRuntime } from "./claude.js";
import { TrackerError } from "./errors.js";
import { OrganizerClient } from "./organizer.js";
import { organizerConnection } from "./settings.js";

/**
 * Corrections par Claude des vulnérabilités que `npm audit fix` laisse dans un
 * clone, d'après la tâche de l'analyse et les commentaires que l'utilisateur y
 * a laissés. Claude modifie le clone (Read, Grep, Glob, Edit, Write et
 * quelques commandes npm : installation, audit, tests), sans git ni écriture
 * hors du clone ; les commandes qu'il lance ne reçoivent pas son token. Il crée
 * une sous-tâche « rapport de développement » de la tâche de l'analyse, ou met
 * à jour celle d'un passage précédent, puis rend un rapport structuré. Le
 * tracker relit la sous-tâche sur l'organizer : absente, rattachée à une autre
 * tâche, mal assignée ou mal taguée, elle fait échouer les corrections.
 */

/** Outils organizer autorisés ; tout autre appel est refusé par `dontAsk`. */
const ORGANIZER_TOOLS = ["get_task", "create_task", "update_task", "set_assignees", "set_tags"];

/** Commandes que Claude peut lancer dans le clone, chacune avec ou sans arguments. */
const ALLOWED_COMMANDS = ["npm install", "npm ci", "npm audit", "npm test", "npm run", "npm ls", "npx tsc"];

/** Réglages de la session : Edit et Write refusent tout chemin hors du clone. */
const SESSION_SETTINGS = { permissions: { blockWritesOutsideWorkingDirectories: true } };

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
  onLine: (line: string, turns: number) => void;
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
    "2. Fix what can be fixed, with minimal changes: upgrade a dependency in package.json, or pin a transitive one with an `overrides` entry, then run `npm install --package-lock-only --ignore-scripts` in the folder of its package-lock.json; adapt the code to the new versions.",
    `3. Check your work: run \`npm audit${omit}\` in each project; install the dependencies with \`npm ci\` and run the tests (\`npm test\`, or the test script of package.json) when the project has some.`,
    "   You can only run npm install, npm ci, npm audit, npm test, npm run, npm ls and npx tsc. Never run git, and never write outside the current directory: the tracker commits your changes, node_modules aside.",
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
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { [ORGANIZER_SERVER]: organizerServer(connection) } }), { encoding: "utf-8", mode: 0o600 });
  let structured: unknown;
  try {
    ({ structured } = await runClaudeSession(input.claude, {
      cwd: input.cwd,
      prompt: prompt(input, space.name, owner, tag),
      args: [
        "--tools",
        "Read,Grep,Glob,Edit,Write,Bash",
        "--allowedTools",
        ["Edit", "Write", ...ALLOWED_COMMANDS.map((command) => `Bash(${command} *)`), ...ORGANIZER_TOOLS.map((tool) => `mcp__${ORGANIZER_SERVER}__${tool}`)].join(","),
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
      onLine: input.onLine,
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
