import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { GUI_LISTEN_HOST, ProxyClient, createLogger, honoGuiGuard, setupLogging } from "@imenam/mcp-gui-interface";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { IPCMessageSchema, type IPCMessage, type IpcErrorKind } from "../shared/schemas/ipc.schema.js";
import { AddRepoBodySchema, CategoryBodySchema, ForceBodySchema, PushBodySchema, SetBranchBodySchema, SetCategoryBodySchema, SetRightsBodySchema } from "../shared/schemas/api.schema.js";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { resolveLogDir } from "./core/log-dir.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findProjectRoot(startDir: string): string {
  let current = startDir;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "gui")) || fs.existsSync(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return startDir;
}

const rootDir = findProjectRoot(__dirname);
const absoluteStaticRoot = path.resolve(path.join(rootDir, "gui/dist"));
const configuredAppPath = process.env.APP_PATH || "/dependabot-tracker";

/**
 * Chemin réellement monté par le proxy. Il diffère de `configuredAppPath` quand
 * `APP_PATH_PREFIX` est défini : le client partagé préfixe alors le chemin et
 * renvoie le chemin final dans `result.path`. Le `<base href>` suit ce chemin.
 */
let effectiveAppPath = configuredAppPath;

/**
 * Deux façons d'exposer la GUI, résolues une seule fois au chargement :
 *   - `proxy`      : PROXY_URL est défini, le proxy attribue le port et monte
 *                    la GUI sous APP_PATH ;
 *   - `standalone` : pas de PROXY_URL mais APP_PORT est défini — la GUI écoute
 *                    directement sur ce port, servie à la racine.
 * PROXY_URL prime quand les deux sont renseignés.
 */
type GuiMode = { kind: "proxy"; proxyUrl: string } | { kind: "standalone"; port: number } | { kind: "disabled"; reason: string };

function resolveGuiMode(): GuiMode {
  const proxyUrl = process.env.PROXY_URL?.trim();
  if (proxyUrl) return { kind: "proxy", proxyUrl };

  const rawPort = process.env.APP_PORT?.trim();
  if (!rawPort) return { kind: "disabled", reason: "PROXY_URL et APP_PORT non définis" };

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { kind: "disabled", reason: `APP_PORT invalide (${rawPort}) — attendu : entier entre 1 et 65535` };
  }
  return { kind: "standalone", port };
}

const guiMode = resolveGuiMode();
const isStandalone = guiMode.kind === "standalone";

setupLogging({ processLabel: "mcp-dependabot-tracker:GUI", logDir: resolveLogDir() });
const logger = createLogger("mcp-dependabot-tracker:GUI");

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  logger.error(err.stack || "No stack trace");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled Rejection: ${reason}`);
  process.exit(1);
});

// Le master peut disparaître sans que l'évènement `disconnect` ne parvienne au
// worker (cas Windows). Deux garde-fous : le canal IPC, fermé dès que le parent
// meurt, et le PID parent, moins fiable car les PID sont recyclés sous Windows.
const parentPid = process.ppid;
const parentCheckInterval = setInterval(() => {
  if (!process.connected) {
    logger.info("IPC channel to the MCP master is closed. Exiting.");
    clearInterval(parentCheckInterval);
    process.exit(0);
    return;
  }
  try {
    process.kill(parentPid, 0);
  } catch {
    logger.info(`Parent process (PID ${parentPid}) is gone. Exiting.`);
    clearInterval(parentCheckInterval);
    process.exit(0);
  }
}, 2000);

const app = new Hono();

// Contrôle de l'hôte appelé et des requêtes de modification, avant toute route.
app.use("*", honoGuiGuard({ proxyUrl: guiMode.kind === "proxy" ? guiMode.proxyUrl : undefined }));

let proxyClient: ProxyClient | null = null;
const pendingRequests = new Map<string, (message: IpcResponse) => void>();

/** Réponse d'une requête IPC : le message du master, ou une erreur locale (timeout, IPC absent). */
type IpcResponse = Pick<IPCMessage, "data" | "error" | "errorKind">;

/** Délai de réponse du master ; l'ajout d'un dépôt interroge GitHub. */
const IPC_TIMEOUT_MS = 45_000;

function safeSend(message: IPCMessage): boolean {
  if (process.send && process.connected) {
    try {
      return process.send(message);
    } catch (err: any) {
      logger.error(`[IPC] Failed to send message: ${err.message}`);
      return false;
    }
  }
  return false;
}

/** Requête IPC vers le master. Ne rejette jamais : un timeout devient une réponse d'erreur. */
function ipcRequest(type: string, data?: unknown): Promise<IpcResponse> {
  const correlationId = Math.random().toString(36).substring(2, 12);
  const message: IPCMessage = { type, correlationId, data, timestamp: new Date().toISOString() };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingRequests.has(correlationId)) {
        pendingRequests.delete(correlationId);
        resolve({ error: `IPC request ${type} timed out after ${IPC_TIMEOUT_MS}ms` });
      }
    }, IPC_TIMEOUT_MS);

    pendingRequests.set(correlationId, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });

    if (!safeSend(message)) {
      clearTimeout(timer);
      pendingRequests.delete(correlationId);
      resolve({ error: "IPC channel to the MCP master is not available" });
    }
  });
}

function setupIpcHandlers() {
  process.on("error", (err: any) => {
    if (err.code === "ERR_IPC_CHANNEL_CLOSED") return;
    logger.error(`Process error: ${err.message}`);
  });

  process.on("disconnect", () => {
    logger.warn("IPC disconnected from MCP master. GUI worker exits.");
    process.exit(0);
  });

  process.on("message", (raw: unknown) => {
    const parsed = IPCMessageSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(`Invalid IPC message ignored: ${parsed.error.message}`);
      return;
    }
    const msg = parsed.data;
    if (msg.correlationId && pendingRequests.has(msg.correlationId)) {
      const resolve = pendingRequests.get(msg.correlationId)!;
      pendingRequests.delete(msg.correlationId);
      resolve(msg);
      return;
    }
    logger.debug(`Unhandled IPC message type: ${msg.type}`);
  });
}

// --- Routes HTTP ------------------------------------------------------------

app.get("/proxy/health", (c) => {
  const memory = process.memoryUsage();
  return c.json({
    status: "ok",
    proxy: proxyClient ? proxyClient.getStatus() : isStandalone ? "standalone" : "error",
    uptime: process.uptime(),
    memory: { rss: memory.rss, heapUsed: memory.heapUsed },
    ipc: process.connected ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

/** Code HTTP d'une erreur renvoyée par le master ; une erreur locale (timeout, IPC absent) est une erreur serveur. */
const HTTP_STATUS_BY_ERROR_KIND: Record<IpcErrorKind, ContentfulStatusCode> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

/** Transmet une requête au master et renvoie sa réponse, ou `{ error }` avec le code HTTP correspondant. */
async function forward(c: Context, type: string, data?: unknown) {
  const result = await ipcRequest(type, data);
  if (result.error !== undefined) {
    return c.json({ error: result.error }, HTTP_STATUS_BY_ERROR_KIND[result.errorKind ?? "internal"]);
  }
  return c.json(result.data);
}

/** Lit et valide le corps JSON d'une requête ; renvoie une réponse 400 explicite s'il est invalide. */
async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<{ body: z.infer<S> } | { response: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (err: any) {
    return { response: c.json({ error: `The request body is not valid JSON: ${err?.message ?? err}` }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`);
    return { response: c.json({ error: `Invalid request body: ${issues.join("; ")}.` }, 400) };
  }
  return { body: parsed.data };
}

/** Identifiant `propriétaire/nom` d'un dépôt, porté par deux segments de chemin. */
function repoId(c: Context): string {
  return `${c.req.param("owner")}/${c.req.param("name")}`;
}

app.get("/api/config", (c) => forward(c, "GET_CONFIG"));

app.get("/api/repos", (c) => forward(c, "LIST_REPOS"));

app.post("/api/repos", async (c) => {
  const read = await readBody(c, AddRepoBodySchema);
  if ("response" in read) return read.response;
  return forward(c, "ADD_REPO", { body: read.body });
});

app.get("/api/github/repos", (c) => forward(c, "LIST_ADDABLE_REPOS"));

app.get("/api/repos/:owner/:name",(c) => forward(c, "GET_REPO", { repoId: repoId(c) }));

app.delete("/api/repos/:owner/:name", (c) => forward(c, "REMOVE_REPO", { repoId: repoId(c) }));

app.put("/api/repos/:owner/:name/rights", async (c) => {
  const read = await readBody(c, SetRightsBodySchema);
  if ("response" in read) return read.response;
  return forward(c, "SET_RIGHTS", { repoId: repoId(c), body: read.body });
});

app.get("/api/repos/:owner/:name/branches", (c) => forward(c, "LIST_BRANCHES", { repoId: repoId(c) }));

app.put("/api/repos/:owner/:name/branch", async (c) => {
  const read = await readBody(c, SetBranchBodySchema);
  if ("response" in read) return read.response;
  return forward(c, "SET_BRANCH", { repoId: repoId(c), body: read.body });
});

app.put("/api/repos/:owner/:name/category", async (c) => {
  const read = await readBody(c, SetCategoryBodySchema);
  if ("response" in read) return read.response;
  return forward(c, "SET_CATEGORY", { repoId: repoId(c), body: read.body });
});

app.get("/api/categories", (c) => forward(c, "LIST_CATEGORIES"));

app.post("/api/categories", async (c) => {
  const read = await readBody(c, CategoryBodySchema);
  if ("response" in read) return read.response;
  return forward(c, "CREATE_CATEGORY", { body: read.body });
});

app.put("/api/categories/:id", async (c) => {
  const read = await readBody(c, CategoryBodySchema);
  if ("response" in read) return read.response;
  return forward(c, "RENAME_CATEGORY", { categoryId: c.req.param("id"), body: read.body });
});

app.delete("/api/categories/:id", (c) => forward(c, "DELETE_CATEGORY", { categoryId: c.req.param("id") }));

app.post("/api/repos/:owner/:name/operations", (c) => forward(c, "START_FIX", { repoId: repoId(c) }));

app.get("/api/operations/:id", (c) => forward(c, "GET_OPERATION", { operationId: c.req.param("id") }));

app.post("/api/operations/:id/force", async (c) => {
  const read = await readBody(c, ForceBodySchema);
  if ("response" in read) return read.response;
  return forward(c, "DECIDE_FORCE", { operationId: c.req.param("id"), body: read.body });
});

app.post("/api/operations/:id/push", async (c) => {
  const read = await readBody(c, PushBodySchema);
  if ("response" in read) return read.response;
  return forward(c, "PUSH_OPERATION", { operationId: c.req.param("id"), body: read.body });
});

app.post("/api/operations/:id/cancel", (c) => forward(c, "CANCEL_OPERATION", { operationId: c.req.param("id") }));

/** Route d'API inconnue : 404 explicite plutôt que la page de la SPA. */
app.all("/api/*", (c) => c.json({ error: `Unknown API route: ${c.req.method} ${c.req.path}` }, 404));

// Fichiers statiques de la SPA
app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), absoluteStaticRoot) }));

function getHtmlBaseHref(appPath: string): string {
  const normalized = appPath.startsWith("/") ? appPath : `/${appPath}`;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

// Toute autre route renvoie la page de la SPA, avec la balise <base> du chemin de montage.
app.get("/*", (c, next) => {
  const urlPath = c.req.path;
  if (urlPath.startsWith("/api") || urlPath.startsWith("/proxy") || urlPath.startsWith("/assets")) return next();

  const indexPath = path.join(absoluteStaticRoot, "index.html");
  if (!fs.existsSync(indexPath)) {
    return c.text(`GUI build not found at ${absoluteStaticRoot}. Run "npm run build:gui" in the package.`, 404);
  }
  // ?__direct=1 : accès au worker sur son port local, sans le proxy — le
  // préfixe de montage ne préfixe alors pas les assets. En mode standalone la
  // GUI est servie à la racine : même règle.
  const baseHref = isStandalone || c.req.query("__direct") === "1" ? "/" : getHtmlBaseHref(effectiveAppPath);
  const html = fs.readFileSync(indexPath, "utf8").replace("<head>", `<head>\n    <base href="${baseHref}" />`);
  return c.html(html);
});

/**
 * Lance Hono sur `port` et prévient le master. `publicUrl` est l'URL que
 * l'utilisateur ouvre : via le proxy, ou directement en localhost.
 */
function listen(port: number, publicUrl: string, isProxied: boolean) {
  const serverInstance = serve({ fetch: app.fetch, port, hostname: GUI_LISTEN_HOST }, (info) => {
    logger.info(`Dependabot Tracker GUI listening on port ${info.port} (${GUI_LISTEN_HOST})`);
    safeSend(IPCMessageSchema.parse({ type: "READY", data: { port: info.port, isProxied, url: publicUrl }, timestamp: new Date().toISOString() }));
  });

  serverInstance.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      // Sortie avec le code 0 : le master ne relance pas de worker supplémentaire.
      logger.error(`Port ${port} already in use — another GUI instance is running.`);
      safeSend(IPCMessageSchema.parse({ type: "ALREADY_RUNNING", data: { url: publicUrl }, timestamp: new Date().toISOString() }));
      process.exit(0);
    }
    logger.error(`Server error: ${err.message}`);
    process.exit(1);
  });
}

/** Sans proxy : la GUI écoute sur APP_PORT et est servie à la racine. */
function startStandalone(port: number) {
  const publicUrl = `http://localhost:${port}`;
  logger.info(`Standalone mode (no PROXY_URL): serving GUI on ${publicUrl}`);
  setupIpcHandlers();
  listen(port, publicUrl, false);
}

async function startServer() {
  if (guiMode.kind === "disabled") {
    process.stderr.write(`[GUI] ${guiMode.reason} — arrêt.\n`);
    process.exit(0);
  }

  if (guiMode.kind === "standalone") {
    startStandalone(guiMode.port);
    return;
  }

  const proxyUrl = guiMode.proxyUrl;
  const appPath = configuredAppPath;
  const appName = process.env.APP_NAME || "Dependabot Tracker";

  logger.info(`Starting server with proxyUrl=${proxyUrl}`);
  proxyClient = new ProxyClient(proxyUrl);

  let result;
  try {
    // APP_GROUP place la GUI dans une section repliable du proxy (facultatif).
    result = await proxyClient.register({ path: appPath, name: appName, group: process.env.APP_GROUP });
  } catch (e: any) {
    process.stderr.write("[GUI] Enregistrement proxy échoué — arrêt.\n");
    logger.error(`Proxy registration error: ${e.message}`);
    process.exit(1);
  }

  if (result.error === "HTTP 409") {
    logger.info("Another GUI instance already registered.");
    safeSend(IPCMessageSchema.parse({ type: "ALREADY_RUNNING", data: { url: `${proxyUrl}${appPath}` }, timestamp: new Date().toISOString() }));
    process.exit(0);
  }

  if (!result.success) {
    process.stderr.write("[GUI] Enregistrement proxy échoué — arrêt.\n");
    logger.error(`Proxy registration failed: ${result.error}`);
    process.exit(1);
  }

  const finalPort = result.port;
  effectiveAppPath = result.path ?? appPath;
  const publicUrl = result.url || `${proxyUrl}${effectiveAppPath}`;
  logger.info(`Registered with proxy. Public URL: ${publicUrl}, Local Port: ${finalPort}`);

  const cleanupProxy = async () => {
    if (proxyClient) await proxyClient.unregister();
    process.exit(0);
  };
  process.on("SIGTERM", cleanupProxy);
  process.on("SIGINT", cleanupProxy);

  setupIpcHandlers();
  listen(finalPort, publicUrl, true);
}

startServer().catch((err: any) => {
  logger.error(`Failed to start GUI Worker: ${err.message}`);
  if (err.stack) logger.error(err.stack);
  process.exit(1);
});
