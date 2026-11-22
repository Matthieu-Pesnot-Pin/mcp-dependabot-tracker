import { AUDIT_SCOPES, DEFAULT_AUDIT_SCOPE } from "../../shared/schemas/model.schema.js";
import type { AgentOperationResponse } from "../../shared/schemas/api.schema.js";
import type { AgentClient } from "./client.js";
import { describeAlerts, describeOperation, describeRepo } from "./format.js";
import { errorResult, optionalBoolean, optionalEnum, optionalString, rejectUnknownFields, requireString, textResult, type Args, type ToolResult } from "./types.js";

const REPOSITORY_PROPERTY = { type: "string", description: "Tracked repository, as owner/name (see list_repositories)." };

const OPERATION_PROPERTY = { type: "string", description: "Id of the operation, as returned by run_audit or fix_vulnerabilities." };

const SCOPE_PROPERTY = {
  type: "string",
  enum: [...AUDIT_SCOPES],
  description: "production (default): the audit and its fixes leave the development dependencies out (npm --omit=dev, pnpm --prod, composer --no-dev). all: every dependency, development ones included.",
};

/** Outils du mode MCP. */
export const TOOLS = [
  {
    name: "list_repositories",
    description:
      "List the tracked repositories that are not deprecated, with their category, their analysed branch, their open Dependabot alerts by severity, the time of the last sync, the pull requests the tracker opened that are still open, and the operation in progress. Start here.",
    inputSchema: {
      type: "object" as const,
      properties: { category: { type: "string", description: "Only list the repositories of this category, by name (case-insensitive). The user creates the categories in the GUI." } },
    },
  },
  {
    name: "get_alerts",
    description:
      "Read the open Dependabot alerts of a tracked repository from GitHub now, and list them from the most to the least severe: number, severity, package, ecosystem, manifest, whether the dependency is a runtime or a development one, summary, patched version and link.",
    inputSchema: { type: "object" as const, properties: { repository: REPOSITORY_PROPERTY }, required: ["repository"] },
  },
  {
    name: "run_audit",
    description:
      "Start the audit of a temporary clone of the analysed branch, in every folder that tracks a lockfile: npm audit (package-lock.json), pnpm audit (pnpm-lock.yaml), composer audit (composer.lock). Nothing is changed; the clone is deleted at the end. Returns at once with the id of the operation: follow it with get_operation.",
    inputSchema: { type: "object" as const, properties: { repository: REPOSITORY_PROPERTY, scope: SCOPE_PROPERTY }, required: ["repository"] },
  },
  {
    name: "fix_vulnerabilities",
    description:
      "Start the fix of the vulnerable dependencies of a tracked repository, the same as the user's Fix button: in a temporary clone of the analysed branch, the audit of every project, then the automatic fixes of its package manager on the lockfiles only (npm audit fix --package-lock-only --ignore-scripts, pnpm audit --fix=update --lockfile-only --ignore-scripts, composer update of the vulnerable packages --no-install --no-scripts --no-plugins), then, when vulnerabilities remain, the fixes by Claude (Claude Code analyses and fixes them in the code, runs the tests and reports in an organizer task), then a commit on a new branch fix/deps-audit-<date>-<time>, its push and a pull request to the analysed branch. " +
      "When the user enabled the automatic workflow of the repository (shown by list_repositories), the pull request is then merged once its checks pass, and the repository deployed on its server. " +
      "Returns at once with the id of the operation: follow it with get_operation. A fix with Claude can take several minutes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repository: REPOSITORY_PROPERTY,
        scope: SCOPE_PROPERTY,
        claude: { type: "boolean", description: "Let Claude fix what the automatic fixes leave (default true). false: only the automatic fixes are pushed." },
      },
      required: ["repository"],
    },
  },
  {
    name: "get_operation",
    description:
      "Read an operation: its status (running, done, failed, cancelled), the step in progress, the vulnerabilities before and after, the updated packages, the fixes by Claude, the pull request and the error. Call it again later while the operation is running.",
    inputSchema: { type: "object" as const, properties: { operation: OPERATION_PROPERTY }, required: ["operation"] },
  },
  {
    name: "cancel_operation",
    description: "Cancel a running operation: its command is stopped, Claude Code included, the clone is deleted and nothing is pushed.",
    inputSchema: { type: "object" as const, properties: { operation: OPERATION_PROPERTY }, required: ["operation"] },
  },
];

/** Compte rendu d'une opération, suivi du lien vers son écran dans la GUI. */
function operationResult({ operation, guiUrl }: AgentOperationResponse): ToolResult {
  const text = `${describeOperation(operation)}\n\nOpen in the GUI: ${guiUrl}`;
  return operation.status === "failed" ? errorResult(text) : textResult(text);
}

/** Exécute l'outil `name` par l'API des agents du serveur. */
export async function callTool(client: AgentClient, name: string, args: Args): Promise<ToolResult> {
  switch (name) {
    case "list_repositories": {
      rejectUnknownFields(args, ["category"]);
      const category = optionalString(args, "category");
      const { repos, category: found } = await client.listRepositories(category);
      const where = found ? `in category ${found.name}` : "tracked";
      if (repos.length === 0) return textResult(found ? `No repository ${where}.` : "No repository is tracked. The user adds repositories in the GUI.");
      return textResult([`${repos.length} repositor${repos.length === 1 ? "y" : "ies"} ${where}:`, ...repos.map(describeRepo)].join("\n"));
    }
    case "get_alerts": {
      rejectUnknownFields(args, ["repository"]);
      const view = await client.syncAlerts(requireString(args, "repository"));
      if (view.repo.syncError) return errorResult(`Could not read the Dependabot alerts of ${view.repo.id}: ${view.repo.syncError}`);
      return textResult(describeAlerts(view.repo));
    }
    case "run_audit": {
      rejectUnknownFields(args, ["repository", "scope"]);
      return operationResult(await client.startAudit(requireString(args, "repository"), optionalEnum(args, "scope", AUDIT_SCOPES, DEFAULT_AUDIT_SCOPE)));
    }
    case "fix_vulnerabilities": {
      rejectUnknownFields(args, ["repository", "scope", "claude"]);
      const scope = optionalEnum(args, "scope", AUDIT_SCOPES, DEFAULT_AUDIT_SCOPE);
      return operationResult(await client.startFix(requireString(args, "repository"), scope, optionalBoolean(args, "claude", true)));
    }
    case "get_operation":
      rejectUnknownFields(args, ["operation"]);
      return operationResult(await client.getOperation(requireString(args, "operation")));
    case "cancel_operation":
      rejectUnknownFields(args, ["operation"]);
      return operationResult(await client.cancelOperation(requireString(args, "operation")));
    default:
      throw new Error(`Tool not found: ${name}`);
  }
}
