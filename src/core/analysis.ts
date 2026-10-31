import fs from "fs";
import path from "path";
import { z } from "zod";
import { AnalysisReportSchema, type AnalysisReport, type AnalysisTask, type ForceCandidate, type Operation } from "../../shared/schemas/model.schema.js";
import type { Settings } from "../../shared/schemas/settings.schema.js";
import { runClaudeSession, type ClaudeRuntime } from "./claude.js";
import { TrackerError } from "./errors.js";
import { OrganizerClient, type OrganizerConnection } from "./organizer.js";
import { organizerConnection } from "./settings.js";
import type { Store } from "./store.js";

/**
 * Analyse par Claude des vulnérabilités que `npm audit fix` laisse dans un
 * clone. Claude lit le code du clone (Read, Grep, Glob, sans commande ni
 * écriture) et n'a accès qu'à quelques outils du MCP organizer, lancé pour la
 * session avec le token réglé dans la GUI : il crée une tâche de reprise,
 * l'assigne au propriétaire de l'espace, lui donne pour tag le nom du dépôt, et
 * rend un rapport structuré. Le tracker relit ensuite la tâche sur
 * l'organizer : une tâche absente, mal assignée ou mal taguée fait échouer
 * l'analyse.
 */

/** Nom du serveur MCP organizer dans la configuration de la session. */
const ORGANIZER_SERVER = "organizer";

const ORGANIZER_PACKAGE = "@imenam/mcp-organizer";

/** Outils organizer autorisés ; tout autre appel est refusé par `dontAsk`. */
const ORGANIZER_TOOLS = ["create_task", "set_assignees", "set_tags", "get_task"];

/** Taille maximale des vulnérabilités transmises dans la consigne. */
const MAX_FACTS_CHARS = 20_000;

/** Chemins d'installation gardés par vulnérabilité. */
const MAX_NODES = 5;

/** Résultat demandé à Claude : le rapport et la clé de la tâche créée. */
const OutputSchema = AnalysisReportSchema.extend({ task: z.string().min(1) });

const OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["task", "summary", "urgent", "force"],
  properties: {
    task: { type: "string", description: "Key of the organizer task you created, e.g. ORG-42." },
    summary: { type: "string", description: "One sentence, in French." },
    urgent: {
      type: "array",
      description: "Vulnerabilities to fix by hand urgently; empty when none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["package", "reason"],
        properties: { package: { type: "string" }, reason: { type: "string", description: "In French." } },
      },
    },
    force: {
      type: "object",
      additionalProperties: false,
      required: ["recommended", "reason"],
      properties: { recommended: { type: "boolean" }, reason: { type: "string", description: "One or two sentences, in French." } },
    },
  },
};

/** Vulnérabilités d'un rapport `npm audit --json`, réduites à ce qui sert l'analyse. */
export function auditFacts(report: any, project: string): unknown[] {
  return Object.values((report?.vulnerabilities ?? {}) as Record<string, any>).map((entry) => ({
    project: project === "" ? "." : project,
    name: entry.name,
    severity: entry.severity,
    isDirect: entry.isDirect,
    range: entry.range,
    via: (Array.isArray(entry.via) ? entry.via : []).map((via: any) =>
      typeof via === "string" ? via : { title: via?.title, url: via?.url, range: via?.range, severity: via?.severity }
    ),
    effects: entry.effects,
    fixAvailable: entry.fixAvailable,
    nodes: (Array.isArray(entry.nodes) ? entry.nodes : []).slice(0, MAX_NODES),
  }));
}

/** JSON des vulnérabilités dans la limite de taille ; au-delà, les dernières sont seulement comptées. */
function factsJson(facts: unknown[]): string {
  for (let count = facts.length; count > 0; count--) {
    const json = JSON.stringify(facts.slice(0, count), null, 1);
    if (json.length <= MAX_FACTS_CHARS) return count === facts.length ? json : `${json}\n(${facts.length - count} more vulnerabilities not listed)`;
  }
  return `(${facts.length} vulnerabilities, too large to list)`;
}

export interface AnalysisInput {
  repoId: string;
  branch: string;
  /** Clone du dépôt : dossier de travail de Claude. */
  cwd: string;
  /** Dossier de l'opération, hors du clone : configuration MCP de la session. */
  workDir: string;
  facts: unknown[];
  forceCandidates: ForceCandidate[];
  settings: Settings;
  claude: ClaudeRuntime;
  signal: AbortSignal;
  onLine: (line: string, turns: number) => void;
}

function prompt(input: AnalysisInput, space: string, owner: { id: string; name: string }, tag: string): string {
  const force =
    input.forceCandidates.length === 0
      ? "No major upgrade fixes them: `npm audit fix --force` would change nothing."
      : [
          "`npm audit fix --force` would apply these major upgrades:",
          ...input.forceCandidates.map((candidate) => `- ${candidate.project === "" ? "" : `${candidate.project}/`}${candidate.name} ${candidate.from ?? "?"} → ${candidate.to}`),
        ].join("\n");
  return [
    `You analyse the npm vulnerabilities that \`npm audit fix\` could not fix in the GitHub repository ${input.repoId} (branch ${input.branch}).`,
    "The current directory is a clone of that branch where `npm audit fix --package-lock-only` already updated the lockfiles. Read the code with Read, Grep and Glob; you cannot run commands nor change files.",
    "",
    "Remaining vulnerabilities, from `npm audit --json` (`project` is the folder of the package-lock.json):",
    "```json",
    factsJson(input.facts),
    "```",
    "",
    force,
    "",
    "Your job:",
    "1. For each vulnerability, find in the code how the vulnerable package is used (directly, or through which dependency), whether the vulnerable code is reachable from this project, and how urgent a fix by hand is.",
    "2. Decide whether `npm audit fix --force` is worth it: check which APIs of the upgraded packages this project uses and whether the major upgrade breaks them.",
    `3. Create one task in the organizer space "${space}" with create_task, without request_id. Write its title and description in French. The description, in markdown, is a complete handover for another agent who will make the fix: the report per vulnerable package (usage in the code, reachability, urgency, advisory link), the decision about --force with its reason, the ordered list of actions, the files concerned, and how to check the result. Set its priority from the urgency.`,
    `4. Assign the task to ${owner.name} with set_assignees (member id ${owner.id}), and set its tags to exactly ["${tag}"] with set_tags.`,
    "5. Finish with the structured report: the key of the task, a one-sentence summary in French, the vulnerabilities to fix by hand urgently (empty when none), and your recommendation about `npm audit fix --force` with its reason, in French.",
  ].join("\n");
}

/** Serveur MCP organizer de la session, lancé par `npx` avec le token réglé dans la GUI. */
function organizerServer(connection: OrganizerConnection) {
  const launch = process.platform === "win32" ? { command: "cmd", args: ["/c", "npx", "-y", ORGANIZER_PACKAGE] } : { command: "npx", args: ["-y", ORGANIZER_PACKAGE] };
  return { ...launch, env: { ORGANIZER_URL: connection.url, ORGANIZER_TOKEN: connection.token } };
}

/** Lance l'analyse, puis vérifie sur l'organizer la tâche que Claude dit avoir créée. */
export async function analyseVulnerabilities(input: AnalysisInput): Promise<{ report: AnalysisReport; task: AnalysisTask }> {
  const connection = organizerConnection(input.settings);
  const token = input.settings.claude.token;
  if (!connection || !token) throw new TrackerError("The analysis needs the organizer connection and the Claude token: set them in the settings.");
  const organizer = new OrganizerClient(connection);
  const { space, owner } = await organizer.space();
  const tag = input.repoId.split("/")[1];

  const configFile = path.join(input.workDir, "analysis-mcp.json");
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { [ORGANIZER_SERVER]: organizerServer(connection) } }), { encoding: "utf-8", mode: 0o600 });
  let structured: unknown;
  try {
    ({ structured } = await runClaudeSession(input.claude, {
      cwd: input.cwd,
      prompt: prompt(input, space.name, owner, tag),
      args: [
        "--tools",
        "Read,Grep,Glob",
        "--allowedTools",
        ORGANIZER_TOOLS.map((tool) => `mcp__${ORGANIZER_SERVER}__${tool}`).join(","),
        "--mcp-config",
        configFile,
        "--strict-mcp-config",
        "--json-schema",
        JSON.stringify(OUTPUT_JSON_SCHEMA),
      ],
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
  if (!output.success) throw new TrackerError("Claude Code ended without the structured report.");
  const task = await organizer.task(output.data.task);
  if (!task.tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase())) {
    throw new TrackerError(`Task ${task.key} was created without the tag "${tag}".`);
  }
  if (!task.assigneeIds.includes(owner.id)) {
    throw new TrackerError(`Task ${task.key} was created without being assigned to ${owner.name}.`);
  }
  const { task: _key, ...report } = output.data;
  return { report, task: { key: task.key, title: task.title, url: organizer.taskUrl(task.id), status: task.status } };
}

/** Dernière opération du dépôt dont l'analyse a créé une tâche ; `operations` va de la plus récente à la plus ancienne. */
export function latestAnalysed(operations: Operation[]): Operation | null {
  return operations.find((operation) => operation.analysis?.task) ?? null;
}

/** Relit sur l'organizer le statut de la dernière tâche d'analyse du dépôt, tant qu'elle n'est pas terminée. */
export async function refreshAnalysisTask(store: Store, settings: Settings, repoId: string): Promise<void> {
  const connection = organizerConnection(settings);
  const operation = latestAnalysed(store.listOperations(repoId));
  const current = operation?.analysis?.task;
  if (!connection || !operation || !current || current.status === "done") return;
  const { status } = await new OrganizerClient(connection).task(current.key);
  if (status === current.status) return;
  store.updateOperation(operation.id, (latest) => ({
    ...latest,
    analysis: latest.analysis && latest.analysis.task ? { ...latest.analysis, task: { ...latest.analysis.task, status } } : latest.analysis,
  }));
}
