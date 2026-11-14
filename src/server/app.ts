import fs from "fs";
import path from "path";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

import {
  AddRepoBodySchema,
  AgentFixBodySchema,
  AlertNumberSchema,
  AuditAllBodySchema,
  CategoryBodySchema,
  MergedBodySchema,
  ScopeBodySchema,
  SetBranchBodySchema,
  SetCategoryBodySchema,
  type AddableReposResponse,
  type AgentOperationResponse,
  type AgentReposResponse,
  type AppConfig,
  type AuditAllResponse,
  type BranchesResponse,
  type CategoriesResponse,
  type OperationResponse,
  type OperationsResponse,
  type ReposResponse,
} from "../../shared/schemas/api.schema.js";
import { CreateAgentTokenBodySchema, type AgentTokensResponse, type CreatedAgentTokenResponse } from "../../shared/schemas/agent-token.schema.js";
import {
  DeployServerBodySchema,
  SaveScriptBodySchema,
  SetDeployServerBodySchema,
  type DeploymentResponse,
  type DeployServersResponse,
} from "../../shared/schemas/deploy.schema.js";
import type { Operation } from "../../shared/schemas/model.schema.js";
import { SaveSettingsBodySchema } from "../../shared/schemas/settings.schema.js";
import { setupCommand } from "../cli/setup-mcp.js";
import { AUTH_BASE_PATH, CLIENT_IP_HEADER, type Auth } from "../core/auth.js";
import { authenticateAgent, createAgentToken, listAgentTokens, revokeAgentToken } from "../core/agent-tokens.js";
import type { AuditAll } from "../core/audit-all.js";
import type { Deployer } from "../core/deployments.js";
import type { GitHubConfig } from "../core/config.js";
import { ConflictError, NotFoundError, TrackerError } from "../core/errors.js";
import { assertMergeAuditPossible, cancelOperation, startAudit, startFix, startMergeAudit, type OperationContext } from "../core/operations.js";
import {
  addRepository,
  auditTargetRepos,
  deprecateRepository,
  listAddableRepositories,
  listRepoBranches,
  listRepoViews,
  markAlertHandled,
  markDeployPending,
  markPullRequestsMerged,
  operationSummary,
  queueCategory,
  queueRepository,
  repoView,
  restoreRepository,
  setBranch,
  setCategory,
  syncAllRepositories,
  syncRepository,
  unmarkAlertHandled,
  unmarkDeployPending,
  unqueueRepository,
} from "../core/repos.js";
import { readSettings, saveSettings, settingsView, testOrganizer, type SettingsChecks } from "../core/settings.js";
import type { Store } from "../core/store.js";
import { APP_VERSION } from "../version.js";

/** Ce dont les routes ont besoin : données, opérations, réglages, authentification et adresse publique du serveur. */
export interface ServerContext {
  store: Store;
  dataDir: string;
  github: GitHubConfig;
  operations: OperationContext;
  auditAll: AuditAll;
  /** Serveurs de déploiement, scripts et déploiements des dépôts. */
  deployer: Deployer;
  settingsChecks: SettingsChecks;
  /** Dossier de la SPA compilée (`gui/dist`). */
  staticRoot: string;
  /** Comptes et sessions de l'interface. */
  auth: Auth;
  /** Clé du coffre (VAULT_KEY), qui chiffre les tokens des réglages. */
  vaultKey: Buffer;
  /** Adresse publique du serveur (APP_URL), sans barre finale. */
  appUrl: string;
  /** Les proxies de confiance sont configurés : X-Forwarded-For est transmis au limiteur de débit. */
  trustsProxies: boolean;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Raison du refus d'une requête de modification venue d'un autre site, ou
 * `null` : Sec-Fetch-Site doit valoir `same-origin` ou `none`, à défaut
 * l'en-tête Origin doit être l'adresse publique du serveur.
 */
export function crossSiteRejection(method: string, headers: { secFetchSite?: string; origin?: string }, appUrl: string): string | null {
  if (SAFE_METHODS.has(method.toUpperCase())) return null;
  const fetchSite = headers.secFetchSite?.trim().toLowerCase();
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none" ? null : `Cross-site request refused (Sec-Fetch-Site: ${fetchSite}).`;
  if (headers.origin === undefined || headers.origin === appUrl) return null;
  return `Cross-site request refused (Origin: ${headers.origin}).`;
}

function statusOf(err: unknown): ContentfulStatusCode {
  if (err instanceof NotFoundError) return 404;
  if (err instanceof ConflictError) return 409;
  if (err instanceof TrackerError) return 400;
  return 500;
}

/** Application Hono du serveur : authentification, API de la GUI, API des agents, fichiers de la SPA. */
export function createApp(ctx: ServerContext): Hono {
  const { store, dataDir, github, operations, auditAll, deployer } = ctx;
  const app = new Hono();

  /** Rend le résultat de `fn` en JSON, ou `{ error }` avec le code HTTP de l'erreur. */
  async function respond(c: Context, fn: () => unknown): Promise<Response> {
    try {
      return c.json((await fn()) as object);
    } catch (err: any) {
      const status = statusOf(err);
      if (status === 500) operations.logError(`${c.req.method} ${c.req.path} failed: ${err?.stack ?? err}`);
      return c.json({ error: err?.message ?? String(err) }, status);
    }
  }

  /** Lit et valide le corps JSON, puis rend le résultat de `fn` ; un corps invalide est une erreur 400 explicite. */
  async function withBody<S extends z.ZodType>(c: Context, schema: S, fn: (body: z.infer<S>) => unknown): Promise<Response> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err: any) {
      return c.json({ error: `The request body is not valid JSON: ${err?.message ?? err}` }, 400);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`);
      return c.json({ error: `Invalid request body: ${issues.join("; ")}.` }, 400);
    }
    return respond(c, () => fn(parsed.data));
  }

  /** Identifiant `propriétaire/nom` d'un dépôt, porté par deux segments de chemin. */
  const repoId = (c: Context) => `${c.req.param("owner")}/${c.req.param("name")}`;

  const alertNumber = (c: Context) => {
    const parsed = AlertNumberSchema.safeParse(c.req.param("number"));
    if (!parsed.success) throw new TrackerError(`Alert number "${c.req.param("number")}" is not a positive integer.`);
    return parsed.data;
  };

  const reposResponse = (): ReposResponse => ({ repos: listRepoViews(store), categories: store.listCategories() });

  const agentOperation = (operation: Operation): AgentOperationResponse => ({
    operation,
    guiUrl: `${ctx.appUrl}#/r/${operation.repoId}/op/${operation.id}`,
  });

  app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() }));

  // --- Authentification -----------------------------------------------------------

  /** Adresse du client vue par la socket, précédée de X-Forwarded-For quand des proxies de confiance sont configurés. */
  const clientIpChain = (c: Context): string => {
    const socketIp = getConnInfo(c).remote.address ?? "";
    const forwarded = ctx.trustsProxies ? c.req.header("x-forwarded-for")?.trim() : undefined;
    return forwarded ? `${forwarded}, ${socketIp}` : socketIp;
  };

  app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set(CLIENT_IP_HEADER, clientIpChain(c));
    return ctx.auth.handler(new Request(c.req.raw, { headers }));
  });

  app.all(`${AUTH_BASE_PATH}/*`, (c) => c.json({ error: `Unknown authentication route: ${c.req.method} ${c.req.path}` }, 404));

  // --- API des agents ------------------------------------------------------------

  app.use("/api/agent/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return c.json({ error: "An agent token is required: Authorization: Bearer <token>." }, 401);
    if (!authenticateAgent(dataDir, match[1])) return c.json({ error: "This agent token is unknown or was revoked." }, 401);
    await next();
  });

  app.get("/api/agent/repos", (c) =>
    respond(c, (): AgentReposResponse => {
      const name = c.req.query("category")?.trim();
      const active = listRepoViews(store).filter((view) => view.repo.deprecatedAt === null);
      if (name === undefined || name === "") return { repos: active, category: null };
      const categories = store.listCategories();
      const category = categories.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      if (!category) {
        const known = categories.length === 0 ? "the user has created none" : `existing categories: ${categories.map((candidate) => candidate.name).join(", ")}`;
        throw new NotFoundError(`Category "${name}" does not exist (${known}).`);
      }
      return { repos: active.filter((view) => view.repo.categoryId === category.id), category };
    })
  );

  app.post("/api/agent/repos/:owner/:name/sync", (c) =>
    respond(c, async () => repoView(store, await syncRepository(store, github, store.getRepo(repoId(c)).id)))
  );

  app.post("/api/agent/repos/:owner/:name/audits", (c) =>
    withBody(c, ScopeBodySchema, (body) => agentOperation(startAudit(operations, repoId(c), "agent", body.scope)))
  );

  app.post("/api/agent/repos/:owner/:name/fixes", (c) =>
    withBody(c, AgentFixBodySchema, (body) => agentOperation(startFix(operations, repoId(c), "agent", { scope: body.scope, claude: body.claude })))
  );

  app.get("/api/agent/operations/:id", (c) => respond(c, () => agentOperation(store.getOperation(c.req.param("id")))));

  app.post("/api/agent/operations/:id/cancel", (c) => respond(c, () => agentOperation(cancelOperation(operations, c.req.param("id")))));

  app.all("/api/agent/*", (c) => c.json({ error: `Unknown agent API route: ${c.req.method} ${c.req.path}` }, 404));

  // --- API de la GUI --------------------------------------------------------------

  // Session ouverte exigée, et refus des modifications venues d'un autre site.
  app.use("/api/*", async (c, next) => {
    const rejection = crossSiteRejection(c.req.method, { secFetchSite: c.req.header("sec-fetch-site"), origin: c.req.header("origin") }, ctx.appUrl);
    if (rejection) return c.json({ error: rejection }, 403);
    const session = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Sign in to use the interface." }, 401);
    await next();
  });

  app.get("/api/config", (c) =>
    respond(c, (): AppConfig => ({ version: APP_VERSION, dataDir, githubServerUrl: github.serverUrl }))
  );

  app.get("/api/repos", (c) => respond(c, reposResponse));

  app.post("/api/repos", (c) =>
    withBody(c, AddRepoBodySchema, async (body) => repoView(store, await addRepository(store, github, body.repository, body.categoryId)))
  );

  app.post("/api/sync", (c) =>
    respond(c, async () => {
      await syncAllRepositories(store, github);
      return reposResponse();
    })
  );

  app.get("/api/audit-all", (c) => respond(c, (): AuditAllResponse => ({ auditAll: auditAll.status() })));

  app.post("/api/audit-all", (c) =>
    withBody(c, AuditAllBodySchema, ({ scope, target }): AuditAllResponse => ({
      auditAll: auditAll.start(auditTargetRepos(store, target).map((repo) => repo.id), scope, target),
    }))
  );

  app.get("/api/github/repos", (c) => respond(c, async (): Promise<AddableReposResponse> => ({ repositories: await listAddableRepositories(store, github) })));

  app.get("/api/repos/:owner/:name", (c) => respond(c, () => repoView(store, store.getRepo(repoId(c)))));

  app.delete("/api/repos/:owner/:name", (c) =>
    respond(c, () => {
      const repo = store.getRepo(repoId(c));
      if (deployer.deployments.active(repo.id)) throw new ConflictError(`A deployment is running on ${repo.id}: interrupt it before removing the repository.`);
      store.removeRepo(repo.id);
      deployer.deployments.removeRepo(repo.id);
      return { removed: true };
    })
  );

  app.put("/api/repos/:owner/:name/deprecated", (c) => respond(c, () => repoView(store, deprecateRepository(store, repoId(c)))));

  app.delete("/api/repos/:owner/:name/deprecated", (c) => respond(c, async () => repoView(store, await restoreRepository(store, github, repoId(c)))));

  app.put("/api/repos/:owner/:name/queued", (c) => respond(c, () => repoView(store, queueRepository(store, repoId(c)))));

  app.delete("/api/repos/:owner/:name/queued", (c) => respond(c, () => repoView(store, unqueueRepository(store, repoId(c)))));

  app.put("/api/repos/:owner/:name/deploy-pending", (c) => respond(c, () => repoView(store, markDeployPending(store, repoId(c)))));

  app.delete("/api/repos/:owner/:name/deploy-pending", (c) => respond(c, () => repoView(store, unmarkDeployPending(store, repoId(c)))));

  app.put("/api/repos/:owner/:name/merged", (c) =>
    withBody(c, MergedBodySchema, ({ deploy }) => {
      const id = repoId(c);
      const merged = store.getRepo(id).pullRequests.map((pull) => pull.number);
      if (merged.length > 0) assertMergeAuditPossible(operations, id);
      const repo = markPullRequestsMerged(store, id, deploy);
      if (merged.length > 0) startMergeAudit(operations, repo.id, merged);
      return repoView(store, repo);
    })
  );

  app.get("/api/repos/:owner/:name/branches", (c) =>
    respond(c, async (): Promise<BranchesResponse> => ({ branches: await listRepoBranches(store, github, repoId(c)) }))
  );

  app.put("/api/repos/:owner/:name/branch", (c) =>
    withBody(c, SetBranchBodySchema, async (body) => repoView(store, await setBranch(store, github, repoId(c), body.branch)))
  );

  app.put("/api/repos/:owner/:name/category", (c) =>
    withBody(c, SetCategoryBodySchema, (body) => repoView(store, setCategory(store, repoId(c), body.categoryId)))
  );

  app.put("/api/repos/:owner/:name/alerts/:number/handled", (c) =>
    respond(c, () => repoView(store, markAlertHandled(store, repoId(c), alertNumber(c))))
  );

  app.delete("/api/repos/:owner/:name/alerts/:number/handled", (c) =>
    respond(c, () => repoView(store, unmarkAlertHandled(store, repoId(c), alertNumber(c))))
  );

  app.get("/api/categories", (c) => respond(c, (): CategoriesResponse => ({ categories: store.listCategories() })));

  app.post("/api/categories", (c) => withBody(c, CategoryBodySchema, (body) => store.createCategory(body.name)));

  app.put("/api/categories/:id", (c) => withBody(c, CategoryBodySchema, (body) => store.renameCategory(c.req.param("id"), body.name)));

  app.delete("/api/categories/:id", (c) =>
    respond(c, () => {
      store.deleteCategory(c.req.param("id"));
      return { deleted: true };
    })
  );

  app.put("/api/categories/:id/queued", (c) =>
    respond(c, () => {
      queueCategory(store, c.req.param("id"));
      return reposResponse();
    })
  );

  app.post("/api/repos/:owner/:name/operations", (c) =>
    withBody(c, ScopeBodySchema, (body): OperationResponse => ({ operation: startFix(operations, repoId(c), "user", { scope: body.scope, claude: true }) }))
  );

  app.get("/api/repos/:owner/:name/operations", (c) =>
    respond(c, (): OperationsResponse => {
      const repo = store.getRepo(repoId(c));
      return { operations: store.listOperations(repo.id).map(operationSummary) };
    })
  );

  app.get("/api/operations/:id", (c) => respond(c, (): OperationResponse => ({ operation: store.getOperation(c.req.param("id")) })));

  app.post("/api/operations/:id/cancel", (c) => respond(c, (): OperationResponse => ({ operation: cancelOperation(operations, c.req.param("id")) })));

  app.get("/api/deploy-servers", (c) =>
    respond(c, (): DeployServersResponse => ({ servers: deployer.servers.list().map((server) => deployer.servers.view(server)) }))
  );

  app.post("/api/deploy-servers", (c) => withBody(c, DeployServerBodySchema, (body) => deployer.servers.view(deployer.servers.create(body))));

  app.put("/api/deploy-servers/:id", (c) =>
    withBody(c, DeployServerBodySchema, (body) => deployer.servers.view(deployer.servers.update(c.req.param("id"), body)))
  );

  app.post("/api/deploy-servers/:id/test", (c) => respond(c, () => deployer.servers.test(c.req.param("id"))));

  /** Opération sur la clé d'un serveur, refusée pendant un déploiement qui l'utilise. */
  const withIdleServer = <T>(c: Context, fn: (id: string) => T): T => {
    const id = deployer.servers.get(c.req.param("id")!).id;
    deployer.assertServerIdle(id);
    return fn(id);
  };

  app.post("/api/deploy-servers/:id/key", (c) => respond(c, () => deployer.servers.installNewKey(c.req.param("id"))));

  app.post("/api/deploy-servers/:id/key/rotate", (c) => respond(c, () => withIdleServer(c, (id) => deployer.servers.rotate(id))));

  app.post("/api/deploy-servers/:id/key/revoke", (c) => respond(c, () => withIdleServer(c, (id) => deployer.servers.revoke(id))));

  app.post("/api/deploy-servers/:id/key/forget", (c) => respond(c, () => withIdleServer(c, (id) => deployer.servers.forget(id))));

  app.get("/api/repos/:owner/:name/deploy", (c) => respond(c, () => deployer.view(repoId(c))));

  app.put("/api/repos/:owner/:name/deploy/server", (c) => withBody(c, SetDeployServerBodySchema, (body) => deployer.setServer(repoId(c), body.serverId)));

  app.put("/api/repos/:owner/:name/deploy/script", (c) => withBody(c, SaveScriptBodySchema, (body) => deployer.saveScript(repoId(c), body.script)));

  app.post("/api/repos/:owner/:name/deployments", (c) => respond(c, async (): Promise<DeploymentResponse> => ({ deployment: await deployer.start(repoId(c)) })));

  app.get("/api/deployments/:id", (c) => respond(c, (): DeploymentResponse => ({ deployment: deployer.deployments.get(c.req.param("id")) })));

  app.post("/api/deployments/:id/cancel", (c) => respond(c, async (): Promise<DeploymentResponse> => ({ deployment: await deployer.cancel(c.req.param("id")) })));

  app.get("/api/settings", (c) => respond(c, () => settingsView(readSettings(dataDir, ctx.vaultKey))));

  app.put("/api/settings", (c) => withBody(c, SaveSettingsBodySchema, (body) => saveSettings(dataDir, ctx.vaultKey, body, ctx.settingsChecks)));

  app.post("/api/settings/organizer/test", (c) => respond(c, () => testOrganizer(dataDir, ctx.vaultKey, ctx.settingsChecks)));

  app.get("/api/agent-tokens", (c) => respond(c, (): AgentTokensResponse => ({ tokens: listAgentTokens(dataDir) })));

  app.post("/api/agent-tokens", (c) =>
    withBody(c, CreateAgentTokenBodySchema, (body): CreatedAgentTokenResponse => {
      const { token, secret } = createAgentToken(dataDir, body.name);
      return { token, secret, setupCommand: setupCommand({ serverUrl: ctx.appUrl, token: secret }) };
    })
  );

  app.delete("/api/agent-tokens/:id", (c) =>
    respond(c, () => {
      revokeAgentToken(dataDir, c.req.param("id"));
      return { revoked: true };
    })
  );

  /** Route d'API inconnue : 404 explicite plutôt que la page de la SPA. */
  app.all("/api/*", (c) => c.json({ error: `Unknown API route: ${c.req.method} ${c.req.path}` }, 404));

  // --- Fichiers de la SPA ---------------------------------------------------------

  app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), ctx.staticRoot) }));

  // Toute autre route renvoie la page de la SPA, qui affiche l'écran de connexion sans session.
  app.get("/*", (c) => {
    const indexPath = path.join(ctx.staticRoot, "index.html");
    if (!fs.existsSync(indexPath)) {
      return c.text(`GUI build not found at ${ctx.staticRoot}. Run "npm run build:gui" in the package.`, 404);
    }
    return c.html(fs.readFileSync(indexPath, "utf8"));
  });

  return app;
}
