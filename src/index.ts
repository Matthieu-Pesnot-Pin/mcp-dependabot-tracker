#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GuiLauncher, createLogger, reconnectGuiToolDefinition, setupLogging } from "@imenam/mcp-gui-interface";
import type { z } from "zod";

import { APP_VERSION } from "./version.js";
import { resolveCloneDir, resolveDataDir } from "./core/data-dir.js";
import { resolveLogDir } from "./core/log-dir.js";
import { githubConfigured, readGitHubConfig } from "./core/config.js";
import { ConflictError, NotFoundError, TrackerError } from "./core/errors.js";
import { Store } from "./core/store.js";
import { cancelOperation, decideForce, pushOperation, runDefaultBranchAudit, startUserFix, type OperationContext } from "./core/operations.js";
import { AuditAll } from "./core/audit-all.js";
import { refreshAnalysisTask } from "./core/analysis.js";
import { checkClaudeToken, packagedClaudeCommand, type ClaudeRuntime } from "./core/claude.js";
import { OrganizerClient } from "./core/organizer.js";
import { readSettings, saveSettings, settingsView, testOrganizer, type SettingsChecks } from "./core/settings.js";
import { SaveSettingsBodySchema } from "../shared/schemas/settings.schema.js";
import { SYNC_INTERVAL_MS, activeRepos, addRepository, deprecateRepository, listAddableRepositories, restoreRepository, listRepoBranches, listRepoViews, markAlertHandled, setBranch, setCategory, repoView, setRights, staleRepos, syncAllRepositories, syncRepository, unmarkAlertHandled } from "./core/repos.js";
import { GUI_REQUEST_TYPES, IPCMessageSchema, type IPCMessage, type IpcErrorKind } from "../shared/schemas/ipc.schema.js";
import {
  AddRepoBodySchema,
  AlertRequestSchema,
  CategoryBodySchema,
  CategoryRequestSchema,
  ForceBodySchema,
  OperationRequestSchema,
  PushBodySchema,
  RepoRequestSchema,
  SetBranchBodySchema,
  SetCategoryBodySchema,
  SetRightsBodySchema,
  type AddableReposResponse,
  type AuditAllResponse,
  type CategoriesResponse,
  type BranchesResponse,
  type ReposResponse,
  type AppConfig,
} from "../shared/schemas/api.schema.js";
import { errorResult, textResult, type ToolResult } from "./tools/types.js";
import { fixVulnerabilities, getAlerts, listRepositories, runAudit, type OperationToolResult } from "./tools/tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Les flags CLI sont traités avant toute initialisation : ils s'exécutent dans le
// répertoire de l'utilisateur, pas dans un serveur MCP.
if (process.argv.slice(2).includes("--claude-setup-mcp")) {
  const argv = process.argv.slice(2);
  const { runSetupMcp, parseGuiExposure } = await import("./cli/setup-mcp.js");
  const parsed = parseGuiExposure(argv);
  if ("error" in parsed) {
    console.error(`Erreur : ${parsed.error}`);
    process.exit(1);
  }
  process.exit(runSetupMcp({ cwd: process.cwd(), force: argv.includes("--force"), exposure: parsed.exposure }));
}

function findProjectRoot(startDir: string): string {
  let current = startDir;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return startDir;
}

const rootDir = findProjectRoot(__dirname);
const packageEnvPath = path.join(rootDir, ".env");

setupLogging({ processLabel: "mcp-dependabot-tracker", logDir: resolveLogDir() });
const logger = createLogger("mcp-dependabot-tracker");

// Rechargé à chaque appel, avec override : le .env local prime sur les
// variables héritées de la déclaration du MCP.
function getConfig() {
  if (fs.existsSync(packageEnvPath)) dotenv.config({ path: packageEnvPath, override: true, quiet: true });
  return { proxyUrl: process.env.PROXY_URL, appPort: process.env.APP_PORT, version: APP_VERSION };
}

getConfig();

let cloneDir: string;
try {
  cloneDir = resolveCloneDir();
} catch (err: any) {
  logger.error(err.message);
  console.error(err.message);
  process.exit(1);
}

const dataDir = resolveDataDir();
const store = new Store(dataDir);

/** Claude Code du paquet, configuré dans `<données>/claude`. */
const claude: ClaudeRuntime = { command: packagedClaudeCommand(), home: path.join(dataDir, "claude") };

const settingsChecks: SettingsChecks = {
  organizer: (connection) => new OrganizerClient(connection).space(),
  claudeToken: (token) => checkClaudeToken(claude, token),
};

const operations: OperationContext = {
  store,
  githubConfig: readGitHubConfig,
  cloneDir: resolveCloneDir,
  logError: (message) => logger.error(message),
  settings: () => readSettings(dataDir),
  claude,
};

/** Série « Auditer tout » de la GUI servie par ce processus. */
const auditAll = new AuditAll(
  (repoId) => runDefaultBranchAudit(operations, repoId),
  (message) => logger.error(message)
);

/** Présentation du serveur transmise au client MCP : concepts, déroulé et règles. */
const INSTRUCTIONS = `mcp-dependabot-tracker follows the Dependabot alerts of GitHub repositories and fixes their npm vulnerabilities. The user tracks repositories and decides what you may do on each of them in a web GUI; you act only through these tools, never with git or npm yourself.

Concepts:
- A **tracked repository** is a GitHub repository the user added in the GUI. Its open Dependabot alerts, and the pull requests the tracker opened that are not merged or closed yet, are read from GitHub and refreshed every 10 minutes.
- A **deprecated repository** is one the user set aside in the GUI: it is neither synced nor audited, list_repositories leaves it out, and every tool refuses it until the user restores it.
- **Rights**: for each repository, the user allows you to run npm audit (audit), npm audit fix (fix), npm audit fix --force (force) and to push the fixes (push). A tool refuses an action you are not allowed to do; only the user can change the rights.
- The **analysed branch** of a repository is chosen by the user in the GUI (the default branch unless changed). Dependabot alerts always describe the default branch; npm audit describes the analysed branch.
- An **operation** runs in a temporary clone of the analysed branch, deleted at the end: npm audit in every directory that holds a package-lock.json, then npm audit fix with --package-lock-only and --ignore-scripts (lockfiles only, no install, no scripts), optionally --force, then a commit on a new branch fix/npm-audit-<date>-<time> and a pull request to the analysed branch.

Workflow:
1. list_repositories to see the tracked repositories, their open alerts and your rights.
2. get_alerts for the detail of the alerts of one repository.
3. run_audit to see what npm audit reports, or fix_vulnerabilities to fix: without push, nothing leaves the temporary clone and the result shows what the fixes would change; with push, the fixes are pushed and the pull request is opened.

Rules:
- An operation runs until it ends; one operation at a time per repository.
- npm audit fix --force can install breaking major versions: use force only when the user asked for it.`;

const server = new Server({ name: "mcp-dependabot-tracker", version: APP_VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

// --- GUI ----------------------------------------------------------------------

function broadcastToGUI(message: IPCMessage) {
  const child = guiLauncher.getProcess();
  if (child?.connected) {
    try {
      child.send(message);
    } catch (err: any) {
      logger.error(`Failed to send IPC message: ${err.message}`);
    }
  }
}

function reply(msg: IPCMessage, data: unknown) {
  broadcastToGUI({ type: `${msg.type}_RESPONSE`, correlationId: msg.correlationId, data, timestamp: new Date().toISOString() });
}

function replyError(msg: IPCMessage, error: string, errorKind: IpcErrorKind) {
  broadcastToGUI({ type: `${msg.type}_RESPONSE`, correlationId: msg.correlationId, error, errorKind, timestamp: new Date().toISOString() });
}

/** Données IPC d'une requête de la GUI, validées par `schema` ; une donnée invalide est une erreur de la requête. */
function parseRequest<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`);
    throw new TrackerError(`Invalid request: ${issues.join("; ")}.`);
  }
  return parsed.data;
}

function errorKindOf(err: unknown): IpcErrorKind {
  if (err instanceof NotFoundError) return "not_found";
  if (err instanceof ConflictError) return "conflict";
  if (err instanceof TrackerError) return "invalid";
  return "internal";
}

/** Traite une requête de la GUI et renvoie ses données de réponse ; lève une erreur métier sinon. */
async function handleGuiRequest(msg: IPCMessage): Promise<unknown> {
  switch (msg.type) {
    case "GET_CONFIG":
      return { version: APP_VERSION, dataDir, githubConfigured: githubConfigured() } satisfies AppConfig;

    case "LIST_REPOS":
      return { repos: listRepoViews(store), categories: store.listCategories() } satisfies ReposResponse;

    case "SYNC_REPOS":
      await syncAllRepositories(store, readGitHubConfig());
      return { repos: listRepoViews(store), categories: store.listCategories() } satisfies ReposResponse;

    case "GET_AUDIT_ALL":
      return { auditAll: auditAll.status() } satisfies AuditAllResponse;

    case "START_AUDIT_ALL":
      readGitHubConfig();
      store.failOrphanedOperations();
      return { auditAll: auditAll.start(activeRepos(store).map((repo) => repo.id)) } satisfies AuditAllResponse;

    case "LIST_ADDABLE_REPOS":
      return { repositories: await listAddableRepositories(store, readGitHubConfig()) } satisfies AddableReposResponse;

    case "GET_REPO": {
      store.failOrphanedOperations();
      return repoView(store, store.getRepo(parseRequest(RepoRequestSchema, msg.data).repoId));
    }

    case "ADD_REPO": {
      const body = parseRequest(AddRepoBodySchema, msg.data?.body);
      return repoView(store, await addRepository(store, readGitHubConfig(), body.repository, body.categoryId));
    }

    case "REMOVE_REPO":
      store.removeRepo(parseRequest(RepoRequestSchema, msg.data).repoId);
      return { removed: true };

    case "DEPRECATE_REPO":
      return repoView(store, deprecateRepository(store, parseRequest(RepoRequestSchema, msg.data).repoId));

    case "RESTORE_REPO":
      return repoView(store, await restoreRepository(store, readGitHubConfig(), parseRequest(RepoRequestSchema, msg.data).repoId));

    case "SET_RIGHTS": {
      const { repoId } = parseRequest(RepoRequestSchema, msg.data);
      const body = parseRequest(SetRightsBodySchema, msg.data?.body);
      return repoView(store, setRights(store, repoId, body.rights));
    }

    case "LIST_BRANCHES": {
      const { repoId } = parseRequest(RepoRequestSchema, msg.data);
      return { branches: await listRepoBranches(store, readGitHubConfig(), repoId) } satisfies BranchesResponse;
    }

    case "SET_BRANCH": {
      const { repoId } = parseRequest(RepoRequestSchema, msg.data);
      const body = parseRequest(SetBranchBodySchema, msg.data?.body);
      return repoView(store, await setBranch(store, readGitHubConfig(), repoId, body.branch));
    }

    case "SET_CATEGORY": {
      const { repoId } = parseRequest(RepoRequestSchema, msg.data);
      const body = parseRequest(SetCategoryBodySchema, msg.data?.body);
      return repoView(store, setCategory(store, repoId, body.categoryId));
    }

    case "MARK_ALERT_HANDLED": {
      const { repoId, number } = parseRequest(AlertRequestSchema, msg.data);
      return repoView(store, markAlertHandled(store, repoId, number));
    }

    case "UNMARK_ALERT_HANDLED": {
      const { repoId, number } = parseRequest(AlertRequestSchema, msg.data);
      return repoView(store, unmarkAlertHandled(store, repoId, number));
    }

    case "LIST_CATEGORIES":
      return { categories: store.listCategories() } satisfies CategoriesResponse;

    case "CREATE_CATEGORY":
      return store.createCategory(parseRequest(CategoryBodySchema, msg.data?.body).name);

    case "RENAME_CATEGORY": {
      const { categoryId } = parseRequest(CategoryRequestSchema, msg.data);
      return store.renameCategory(categoryId, parseRequest(CategoryBodySchema, msg.data?.body).name);
    }

    case "DELETE_CATEGORY":
      store.deleteCategory(parseRequest(CategoryRequestSchema, msg.data).categoryId);
      return { deleted: true };

    case "START_FIX":
      return { operation: startUserFix(operations, parseRequest(RepoRequestSchema, msg.data).repoId) };

    case "GET_OPERATION": {
      store.failOrphanedOperations();
      return { operation: store.getOperation(parseRequest(OperationRequestSchema, msg.data).operationId) };
    }

    case "DECIDE_FORCE": {
      const { operationId } = parseRequest(OperationRequestSchema, msg.data);
      return { operation: decideForce(operations, operationId, parseRequest(ForceBodySchema, msg.data?.body).apply) };
    }

    case "PUSH_OPERATION": {
      const { operationId } = parseRequest(OperationRequestSchema, msg.data);
      return { operation: pushOperation(operations, operationId, parseRequest(PushBodySchema, msg.data?.body).commitMessage) };
    }

    case "CANCEL_OPERATION":
      return { operation: cancelOperation(operations, parseRequest(OperationRequestSchema, msg.data).operationId) };

    case "GET_SETTINGS":
      return settingsView(readSettings(dataDir));

    case "SAVE_SETTINGS":
      return saveSettings(dataDir, parseRequest(SaveSettingsBodySchema, msg.data?.body), settingsChecks);

    case "TEST_ORGANIZER":
      return testOrganizer(dataDir, settingsChecks);

    default:
      throw new Error(`GUI request ${msg.type} has no handler.`);
  }
}

const GUI_REQUESTS = new Set<string>(GUI_REQUEST_TYPES);

/**
 * Messages du GUI worker. READY et ALREADY_RUNNING sont d'abord traités par
 * GuiLauncher (statut, URL), puis transmis ici.
 */
function handleIPCMessage(raw: unknown) {
  const parsed = IPCMessageSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(`Invalid IPC message ignored: ${parsed.error.message}`);
    return;
  }
  const msg = parsed.data;

  switch (msg.type) {
    case "READY":
      logger.info(`GUI ready at ${msg.data?.url}`);
      return;

    case "ALREADY_RUNNING":
      logger.info(`GUI already served by another instance at ${msg.data?.url}`);
      return;

    default:
      if (GUI_REQUESTS.has(msg.type)) {
        handleGuiRequest(msg).then(
          (data) => reply(msg, data),
          (err: any) => {
            const kind = errorKindOf(err);
            if (kind === "internal") logger.error(`GUI request ${msg.type} failed: ${err?.stack ?? err}`);
            replyError(msg, err?.message ?? String(err), kind);
          }
        );
        return;
      }
      logger.debug(`Unhandled IPC message type: ${msg.type}`);
  }
}

const guiLauncher = new GuiLauncher({
  guiPath: path.join(__dirname, "gui-worker.js"),
  maxRestarts: 0,
  onMessage: handleIPCMessage,
  reloadEnv: getConfig,
});

/** La GUI a besoin soit d'un proxy, soit d'un port local (mode standalone). */
function guiIsConfigured(): boolean {
  return !!(process.env.PROXY_URL?.trim() || process.env.APP_PORT?.trim());
}

function launchGUI() {
  if (!guiIsConfigured()) {
    logger.info("[MASTER] Ni PROXY_URL ni APP_PORT défini — GUI désactivée.");
    return;
  }
  logger.info("Launching GUI worker...");
  guiLauncher.start();
}

/**
 * `reconnect_gui` : relance via GuiLauncher en mode proxy. En mode standalone,
 * GuiLauncher ne sait pas relancer le worker : l'outil décrit l'état et la
 * marche à suivre.
 */
async function reconnectGui(args: Record<string, unknown>): Promise<ToolResult> {
  getConfig();
  const appPort = process.env.APP_PORT?.trim();
  if (process.env.PROXY_URL?.trim() || !appPort) {
    return { ...(await guiLauncher.handleReconnectTool({ force: args.force === true })) };
  }
  const child = guiLauncher.getProcess();
  const alive = !!child && child.exitCode === null && !child.killed;
  const url = guiLauncher.getUrl();
  if (alive && guiLauncher.getStatus() === "ready") {
    return textResult(`GUI is served in standalone mode at ${url}. Nothing to do.`);
  }
  return errorResult(
    `reconnect_gui relaunches the GUI through the proxy only. The GUI is in standalone mode (APP_PORT=${appPort}) and is not running (status: ${guiLauncher.getStatus()}). Free port ${appPort} or set another APP_PORT, then restart the MCP server. To use the proxy instead, set PROXY_URL and call reconnect_gui again.`
  );
}

// --- Synchronisation des alertes ---------------------------------------------------

const SYNC_CHECK_MS = 60_000;
let syncing = false;

/**
 * Relit les alertes des dépôts dont la dernière lecture date de plus de 10
 * minutes, et le statut de la tâche organizer de leur dernière analyse.
 */
async function syncStaleRepos() {
  if (syncing || !githubConfigured()) return;
  syncing = true;
  try {
    const config = readGitHubConfig();
    for (const repo of staleRepos(store, SYNC_INTERVAL_MS)) {
      const synced = await syncRepository(store, config, repo.id);
      if (synced.syncError) logger.warn(`Dependabot alerts of ${repo.id} not synced: ${synced.syncError}`);
      await refreshAnalysisTask(store, readSettings(dataDir), repo.id).catch((err: any) =>
        logger.warn(`Organizer task of ${repo.id} not refreshed: ${err?.message ?? err}`)
      );
    }
  } catch (err: any) {
    logger.error(`Alert sync failed: ${err?.stack ?? err}`);
  } finally {
    syncing = false;
  }
}

// --- Outils -------------------------------------------------------------------

const REPOSITORY_DOC = "Tracked repository, as owner/name (see list_repositories).";

const TOOLS = [
  {
    name: "list_repositories",
    description:
      "List the tracked repositories that are not deprecated, with their category, their analysed branch, their open Dependabot alerts by severity, the time of the last sync, the rights the user gave you (audit, fix, force, push), the pull requests the tracker opened that are still open, and the operation in progress. Start here.",
    inputSchema: {
      type: "object" as const,
      properties: { category: { type: "string", description: "Only list the repositories of this category, by name (case-insensitive). The user creates the categories in the GUI." } },
    },
  },
  {
    name: "get_alerts",
    description:
      "Read the open Dependabot alerts of a tracked repository from GitHub now, and list them from the most to the least severe: number, severity, package, ecosystem, manifest, summary, patched version and link.",
    inputSchema: {
      type: "object" as const,
      properties: { repository: { type: "string", description: REPOSITORY_DOC } },
      required: ["repository"],
    },
  },
  {
    name: "run_audit",
    description:
      "Run npm audit on a temporary clone of the analysed branch, in every directory that holds a package-lock.json, and report the vulnerabilities with the fix npm proposes (none, within the declared ranges, or a major upgrade that needs --force). Needs the audit right. Nothing is changed; the clone is deleted.",
    inputSchema: {
      type: "object" as const,
      properties: { repository: { type: "string", description: REPOSITORY_DOC } },
      required: ["repository"],
    },
  },
  {
    name: "fix_vulnerabilities",
    description:
      "Fix the npm vulnerabilities of a tracked repository in a temporary clone of its analysed branch: npm audit, then npm audit fix --package-lock-only --ignore-scripts, then optionally npm audit fix --force, then optionally a commit on a new branch fix/npm-audit-<date>-<time>, its push and a pull request to the analysed branch. " +
      "Needs the fix right, plus the force right with force and the push right with push. Without push, nothing leaves the clone: the result reports what the fixes change. Waits until the operation ends and reports the vulnerabilities before and after, the updated packages and the pull request.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repository: { type: "string", description: REPOSITORY_DOC },
        force: {
          type: "boolean",
          description: "Also run npm audit fix --force when vulnerabilities remain that only a major upgrade fixes (default false). Breaking changes possible: only when the user asked for it.",
        },
        push: { type: "boolean", description: "Commit the fixes on a new branch, push it and open a pull request (default false)." },
        commit_message: { type: "string", description: "Commit message, also the pull request title (first line). Default \"fix(deps): resolve npm audit vulnerabilities\"." },
      },
      required: ["repository"],
    },
  },
  reconnectGuiToolDefinition(),
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

/** Lien vers un écran de la GUI, ajouté aux résultats des opérations ; vide quand la GUI est désactivée. */
function guiHint(hash: string): string {
  const url = guiLauncher.getUrl();
  if (!url) return "";
  return `\n\nOpen in the GUI: ${url}#/${hash}`;
}

/** Ajoute au résultat d'une opération le lien vers son écran dans la GUI. */
function withOperationLink({ result, operation }: OperationToolResult): ToolResult {
  const hint = guiHint(`r/${operation.repoId}/op/${operation.id}`);
  return { ...result, content: [{ type: "text", text: result.content[0].text + hint }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;
  const params = (args ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "list_repositories":
        return listRepositories(store, params);
      case "get_alerts":
        return await getAlerts(store, readGitHubConfig(), params);
      case "run_audit":
        return withOperationLink(await runAudit(operations, params));
      case "fix_vulnerabilities":
        return withOperationLink(await fixVulnerabilities(operations, params));
      case "reconnect_gui":
        return await reconnectGui(params);
      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (error: any) {
    return errorResult(error.message);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`MCP Server connected and running on stdio (data dir: ${dataDir}, clone dir: ${cloneDir})`);
  for (const orphan of store.failOrphanedOperations()) logger.warn(`Operation ${orphan.id} on ${orphan.repoId} was interrupted.`);
  launchGUI();
  void syncStaleRepos();
  setInterval(() => void syncStaleRepos(), SYNC_CHECK_MS).unref();
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught Exception in MASTER: ${err.message}`);
  logger.error(err.stack || "No stack trace");
  guiLauncher.getProcess()?.kill("SIGTERM");
  process.exit(1);
});
