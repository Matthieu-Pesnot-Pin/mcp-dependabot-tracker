import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { serve as serveHttp } from "@hono/node-server";
import { GUI_LISTEN_HOST, ProxyClient, createLogger, setupLogging } from "@imenam/mcp-gui-interface";
import type { Hono } from "hono";

import { AuditAll } from "../core/audit-all.js";
import { checkClaudeToken, packagedClaudeCommand, type ClaudeRuntime } from "../core/claude.js";
import { readGitHubConfig, type GitHubConfig } from "../core/config.js";
import { resolveCloneDir, resolveDataDir } from "../core/data-dir.js";
import { resolveLogDir } from "../core/log-dir.js";
import { runDefaultBranchAudit, type OperationContext } from "../core/operations.js";
import { OrganizerClient } from "../core/organizer.js";
import { refreshReportTask } from "../core/repair.js";
import { SYNC_INTERVAL_MS, staleRepos, syncRepository } from "../core/repos.js";
import { readSettings, type SettingsChecks } from "../core/settings.js";
import { Store } from "../core/store.js";
import { APP_VERSION } from "../version.js";
import { createApp } from "./app.js";

/** Chemin de montage derrière le proxy, quand APP_PATH ne le fixe pas. */
const DEFAULT_APP_PATH = "/dependabot-tracker";

const DEFAULT_APP_NAME = "Dependabot Tracker";

/** Intervalle de vérification des dépôts à relire. */
const SYNC_CHECK_MS = 60_000;

/**
 * Exposition du serveur : `proxy` quand PROXY_URL est défini (le proxy attribue
 * le port et monte l'interface sous APP_PATH), `port` quand APP_PORT l'est
 * (l'interface est servie à la racine de http://localhost:<port>).
 */
type Exposure = { kind: "proxy"; proxyUrl: string } | { kind: "port"; port: number };

/** Lit l'exposition dans l'environnement ; lève une erreur si aucune, ou les deux, sont définies. */
export function resolveExposure(env: NodeJS.ProcessEnv = process.env): Exposure {
  const proxyUrl = env.PROXY_URL?.trim();
  const rawPort = env.APP_PORT?.trim();
  if (proxyUrl && rawPort) throw new Error("PROXY_URL and APP_PORT are both set: the server is exposed through the proxy or on a local port, not both.");
  if (proxyUrl) return { kind: "proxy", proxyUrl: proxyUrl.replace(/\/+$/, "") };
  if (!rawPort) throw new Error("Neither PROXY_URL nor APP_PORT is set: declare the proxy to register with, or the local port to listen on.");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`APP_PORT is invalid (${rawPort}): expected an integer between 1 and 65535.`);
  return { kind: "port", port };
}

/** Racine du paquet : le premier dossier qui contient un package.json, en remontant depuis ce module. */
function packageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(current, "package.json"))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("package.json not found above the server module.");
    current = parent;
  }
  return current;
}

/** Met le serveur à l'écoute de `port` sur l'interface locale ; un port occupé arrête le serveur. */
function listen(app: Hono, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = serveHttp({ fetch: app.fetch, port, hostname: GUI_LISTEN_HOST }, () => resolve());
    server.on("error", (err: any) => {
      reject(err.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use: another server listens on it.`) : err);
    });
  });
}

/**
 * Serveur Dependabot Tracker : interface, API de la GUI et des agents,
 * opérations et relecture périodique des alertes, dans un seul processus.
 */
export async function serve(): Promise<void> {
  const root = packageRoot();
  const envFile = path.join(root, ".env");
  if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: true, quiet: true });

  setupLogging({ processLabel: "mcp-dependabot-tracker", logDir: resolveLogDir() });
  const logger = createLogger("mcp-dependabot-tracker");

  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err.stack ?? err.message}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason: any) => {
    logger.error(`Unhandled rejection: ${reason?.stack ?? reason}`);
    process.exit(1);
  });

  let github: GitHubConfig;
  let cloneDir: string;
  let exposure: Exposure;
  try {
    github = readGitHubConfig();
    cloneDir = resolveCloneDir();
    exposure = resolveExposure();
  } catch (err: any) {
    logger.error(err.message);
    process.exit(1);
  }

  const dataDir = resolveDataDir();
  const store = new Store(dataDir);
  const claude: ClaudeRuntime = { command: packagedClaudeCommand(), home: path.join(dataDir, "claude") };
  const settingsChecks: SettingsChecks = {
    organizer: (connection) => new OrganizerClient(connection).space(),
    claudeToken: (token) => checkClaudeToken(claude, token),
  };
  const operations: OperationContext = {
    store,
    githubConfig: () => github,
    cloneDir: () => cloneDir,
    logError: (message) => logger.error(message),
    settings: () => readSettings(dataDir),
    claude,
  };
  const auditAll = new AuditAll((repoId, scope) => runDefaultBranchAudit(operations, repoId, scope), (message) => logger.error(message));

  let publicUrl = "";
  let mountPath = "/";
  let proxyClient: ProxyClient | null = null;
  const app = createApp({
    store,
    dataDir,
    github,
    operations,
    auditAll,
    settingsChecks,
    staticRoot: path.join(root, "gui", "dist"),
    proxyUrl: exposure.kind === "proxy" ? exposure.proxyUrl : undefined,
    publicUrl: () => publicUrl,
    mountPath: () => mountPath,
    proxyStatus: () => (proxyClient ? proxyClient.getStatus() : "standalone"),
  });

  let port: number;
  if (exposure.kind === "proxy") {
    proxyClient = new ProxyClient(exposure.proxyUrl);
    const result = await proxyClient.register({ path: DEFAULT_APP_PATH, name: DEFAULT_APP_NAME });
    if (!result.success) {
      const reason = result.error === "HTTP 409" ? `another server is already registered under ${result.path}` : result.error;
      logger.error(`Registration with the proxy ${exposure.proxyUrl} failed: ${reason}.`);
      process.exit(1);
    }
    port = result.port;
    mountPath = result.path ?? DEFAULT_APP_PATH;
    publicUrl = (result.url || `${exposure.proxyUrl}${mountPath}`).replace(/\/+$/, "");
    const client = proxyClient;
    const stop = async () => {
      await client.unregister();
      process.exit(0);
    };
    process.on("SIGTERM", () => void stop());
    process.on("SIGINT", () => void stop());
  } else {
    port = exposure.port;
    publicUrl = `http://localhost:${port}`;
    process.on("SIGTERM", () => process.exit(0));
    process.on("SIGINT", () => process.exit(0));
  }

  try {
    await listen(app, port);
  } catch (err: any) {
    logger.error(err.message);
    process.exit(1);
  }

  for (const operation of store.failInterruptedOperations()) logger.warn(`Operation ${operation.id} on ${operation.repoId} was interrupted by the last stop of the server.`);
  logger.info(`Dependabot Tracker ${APP_VERSION} serves ${publicUrl} (port ${port}, data dir ${dataDir}, clone dir ${cloneDir})`);

  let syncing = false;
  /** Relit les alertes des dépôts lus il y a plus de 10 minutes, et le statut de la tâche organizer du dernier rapport de Claude. */
  const syncStaleRepos = async () => {
    if (syncing) return;
    syncing = true;
    try {
      for (const repo of staleRepos(store, SYNC_INTERVAL_MS)) {
        const synced = await syncRepository(store, github, repo.id);
        if (synced.syncError) logger.warn(`Dependabot alerts of ${repo.id} not synced: ${synced.syncError}`);
        await refreshReportTask(store, readSettings(dataDir), repo.id).catch((err: any) =>
          logger.warn(`Organizer task of ${repo.id} not refreshed: ${err?.message ?? err}`)
        );
      }
    } catch (err: any) {
      logger.error(`Alert sync failed: ${err?.stack ?? err}`);
    } finally {
      syncing = false;
    }
  };
  void syncStaleRepos();
  setInterval(() => void syncStaleRepos(), SYNC_CHECK_MS);
}
