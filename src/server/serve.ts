import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { serve as serveHttp } from "@hono/node-server";
import { createLogger, setupLogging } from "@imenam/mcp-gui-interface";
import type { Hono } from "hono";

import { AuditAll } from "../core/audit-all.js";
import { createAuth, listUsers, migrateAuth, type Auth } from "../core/auth.js";
import { checkClaudeToken, packagedClaudeCommand, type ClaudeRuntime } from "../core/claude.js";
import { readGitHubConfig, type GitHubConfig } from "../core/config.js";
import { resolveCloneDir, resolveDataDir } from "../core/data-dir.js";
import { DeployServerStore } from "../core/deploy-servers.js";
import { Deployer, DeploymentStore } from "../core/deployments.js";
import { resolveLogDir } from "../core/log-dir.js";
import { runDefaultBranchAudit, type OperationContext } from "../core/operations.js";
import { OrganizerClient } from "../core/organizer.js";
import { refreshReportTask } from "../core/repair.js";
import { SYNC_INTERVAL_MS, staleRepos, syncRepository } from "../core/repos.js";
import { encryptStoredTokens, readSettings, type SettingsChecks } from "../core/settings.js";
import { readServerConfig, type ServerConfig } from "../core/server-config.js";
import { Store } from "../core/store.js";
import { parseVaultKey } from "../core/vault.js";
import { APP_VERSION } from "../version.js";
import { createApp } from "./app.js";

/** Intervalle de vérification des dépôts à relire. */
const SYNC_CHECK_MS = 60_000;

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

/** Charge le `.env` de la racine du paquet, s'il existe ; ses valeurs priment sur l'environnement. */
export function loadPackageEnv(): void {
  const envFile = path.join(packageRoot(), ".env");
  if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: true, quiet: true });
}

/** Met le serveur à l'écoute de `port` sur l'adresse `hostname` ; un port occupé arrête le serveur. */
function listen(app: Hono, port: number, hostname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = serveHttp({ fetch: app.fetch, port, hostname }, () => resolve());
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
  loadPackageEnv();

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
  let config: ServerConfig;
  let vaultKey: Buffer;
  try {
    github = readGitHubConfig();
    cloneDir = resolveCloneDir();
    config = readServerConfig();
    vaultKey = parseVaultKey(process.env.VAULT_KEY);
  } catch (err: any) {
    logger.error(err.message);
    process.exit(1);
  }

  const dataDir = resolveDataDir();
  let auth: Auth;
  try {
    auth = createAuth(dataDir, config);
    await migrateAuth(auth);
  } catch (err: any) {
    logger.error(`The account database cannot be opened: ${err?.stack ?? err}`);
    process.exit(1);
  }
  const store = new Store(dataDir);
  const deployServers = new DeployServerStore(dataDir, vaultKey);
  try {
    deployServers.verifyVault();
    if (encryptStoredTokens(dataDir, vaultKey)) logger.info("The tokens of settings.json are now encrypted with VAULT_KEY.");
    readSettings(dataDir, vaultKey);
  } catch (err: any) {
    logger.error(err.message);
    process.exit(1);
  }
  const deployer = new Deployer(store, deployServers, new DeploymentStore(dataDir), github, (message) => logger.error(message));
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
    settings: () => readSettings(dataDir, vaultKey),
    claude,
  };
  const auditAll = new AuditAll((repoId, scope) => runDefaultBranchAudit(operations, repoId, scope), (message) => logger.error(message));

  const app = createApp({
    store,
    dataDir,
    github,
    operations,
    auditAll,
    deployer,
    settingsChecks,
    staticRoot: path.join(root, "gui", "dist"),
    auth,
    vaultKey,
    appUrl: config.appUrl,
    trustsProxies: config.trustedProxies.length > 0,
  });

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  try {
    await listen(app, config.port, config.listenHost);
  } catch (err: any) {
    logger.error(err.message);
    process.exit(1);
  }

  for (const deployment of deployer.deployments.failInterrupted()) logger.warn(`Deployment ${deployment.id} on ${deployment.repoId} was interrupted by the last stop of the server.`);
  for (const operation of store.failInterruptedOperations()) logger.warn(`Operation ${operation.id} on ${operation.repoId} was interrupted by the last stop of the server.`);
  logger.info(`Dependabot Tracker ${APP_VERSION} serves ${config.appUrl} (port ${config.port} on ${config.listenHost}, data dir ${dataDir}, clone dir ${cloneDir})`);
  const users = await listUsers(auth);
  if (users.length === 0) logger.warn('No account exists yet: create one with "mcp-dependabot-tracker user add <email>".');
  for (const user of users.filter((candidate) => !candidate.twoFactor)) {
    logger.warn(`The account ${user.email} signs in with its password alone: enable two-factor authentication with "mcp-dependabot-tracker user totp ${user.email}".`);
  }

  let syncing = false;
  /** Relit les alertes des dépôts lus il y a plus de 10 minutes, et le statut de la tâche organizer du dernier rapport de Claude. */
  const syncStaleRepos = async () => {
    if (syncing) return;
    syncing = true;
    try {
      for (const repo of staleRepos(store, SYNC_INTERVAL_MS)) {
        const synced = await syncRepository(store, github, repo.id);
        if (synced.syncError) logger.warn(`Dependabot alerts of ${repo.id} not synced: ${synced.syncError}`);
        await refreshReportTask(store, readSettings(dataDir, vaultKey), repo.id).catch((err: any) =>
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
