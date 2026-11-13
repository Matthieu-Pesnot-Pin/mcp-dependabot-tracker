import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

import { FakeGitHub, LocalRemotes, McpClient, SERVER_ENTRY, TEST_AUTH_SECRET, TEST_USER, TEST_VAULT_KEY, TrackerServer, VULNERABLE_FIXTURE, baseEnv, runUserCommand, signIn, freePort, makeTempDir, npmRegistryReachable, waitFor } from "./helpers.js";

/**
 * Serveur réel lancé par `serve` sur un port libre, la fausse API GitHub et des
 * dépôts distants locaux ; le mode MCP réel, sur stdio, le pilote avec un token
 * d'agent créé par l'API de la GUI : outils de l'agent, tokens et parcours
 * complet de la GUI.
 */

const online = await npmRegistryReachable();
const skip = online ? false : "the npm registry is unreachable: npm audit needs it";

let server: TrackerServer;
let client: McpClient;
let temp: { dir: string; cleanup: () => void };
let github: FakeGitHub;
let remotes: LocalRemotes;
let baseUrl = "";
let serverEnv: Record<string, string | undefined> = {};
let cookie = "";
let port = 0;
let token: { id: string; secret: string; setupCommand: string };

async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}/api/${route}`, {
    method,
    headers: { Cookie: cookie, ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

/** Appelle `get_operation` jusqu'à la fin de l'opération ; rend son dernier compte rendu. */
async function settledOperation(id: string): Promise<{ text: string; isError: boolean }> {
  return waitFor(`operation ${id}`, () => client.callTool("get_operation", { operation: id }), (result) => !/\): running\./.test(result.text), 180_000);
}

/** Identifiant de l'opération cité par le compte rendu d'un outil. */
function operationId(text: string): string {
  const match = /\(operation (op-[a-z0-9-]+)\)/.exec(text);
  assert.ok(match, text);
  return match[1];
}

before(async () => {
  temp = makeTempDir("tracker-server-");
  github = new FakeGitHub();
  await github.start();
  remotes = new LocalRemotes(path.join(temp.dir, "remotes"));
  remotes.create("octo", "demo", "main", { ".": VULNERABLE_FIXTURE });
  github.addRepo("octo", "demo", "main", [
    { number: 3, severity: "medium", package: "cookie", summary: "Cookie name issue" },
    { number: 1, severity: "high", package: "lodash", summary: "Command Injection in lodash" },
    { number: 2, severity: "critical", package: "simple-git", summary: "Remote code execution" },
  ]);
  github.addRepo("octo", "locked", "main", [], ["release", "develop", "main"]);
  remotes.create("octo", "quiet", "main", { ".": VULNERABLE_FIXTURE });
  github.addRepo("octo", "quiet", "main", []);
  for (const name of ["extra-1", "extra-2", "extra-3"]) github.addRepo("octo", name, "main", []);
  github.repos.get("octo/locked")!.alertsStatus = 403;

  port = await freePort();
  baseUrl = `http://localhost:${port}`;
  serverEnv = {
    ...baseEnv(),
    MCP_DATA_DIR: path.join(temp.dir, "data"),
    CLONE_DIR: path.join(temp.dir, "clones", "nested"),
    GITHUB_TOKEN: github.token,
    GITHUB_API_URL: github.url,
    GITHUB_SERVER_URL: remotes.serverUrl,
    APP_PORT: String(port),
    VAULT_KEY: TEST_VAULT_KEY,
    APP_URL: `http://localhost:${port}`,
    AUTH_SECRET: TEST_AUTH_SECRET,
  };
  const account = await runUserCommand(serverEnv, ["add", TEST_USER.email], `${TEST_USER.password}\n`);
  assert.equal(account.code, 0, account.stderr);
  server = new TrackerServer(serverEnv);
  await waitFor("the server", () => fetch(`${baseUrl}/health`).then((r) => r.ok, () => false), (ok) => ok, 20_000);
  cookie = await signIn(baseUrl);

  const created = await call("POST", "agent-tokens", { name: "Tests" });
  assert.equal(created.status, 200, created.json.error);
  token = { id: created.json.token.id, secret: created.json.secret, setupCommand: created.json.setupCommand };
  client = new McpClient({ ...baseEnv(), SERVER_URL: baseUrl, AGENT_TOKEN: token.secret });
  await client.initialize("tracker-server-test");
});

after(async () => {
  await client?.stop();
  await server?.stop();
  await github?.stop();
  temp?.cleanup();
});

test("the MCP mode lists its tools; the server serves the GUI page", async () => {
  const { tools } = await client.request("tools/list");
  assert.deepEqual(
    tools.map((tool: { name: string }) => tool.name),
    ["list_repositories", "get_alerts", "run_audit", "fix_vulnerabilities", "get_operation", "cancel_operation"]
  );
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root">/);
  const config = await call("GET", "config");
  assert.equal(config.json.githubServerUrl, remotes.serverUrl);
  assert.equal((await call("GET", "nope")).status, 404);
  assert.match(server.stderr.join(""), new RegExp(`Dependabot Tracker \\S+ serves http://localhost:${port} `));
});

test("the GUI API needs a session; sign-in, cross-site requests, sign-out and the account commands", async () => {
  const anonymous = await fetch(`${baseUrl}/api/repos`);
  assert.equal(anonymous.status, 401);
  assert.match((await anonymous.json()).error, /Sign in/);

  const wrong = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ email: TEST_USER.email, password: "not the password" }),
  });
  assert.equal(wrong.status, 401);
  const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ email: "intruder@example.com", password: "a long enough password", name: "x" }),
  });
  assert.ok(signUp.status >= 400, "sign-up is closed");

  assert.equal((await call("GET", "repos")).status, 200);
  assert.equal((await call("POST", "categories", { name: "Cross" }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await call("POST", "categories", { name: "Cross" }, { "Sec-Fetch-Site": "cross-site" })).status, 403);

  const env = serverEnv;
  const duplicate = await runUserCommand(env, ["add", TEST_USER.email], "another long password\n");
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /already uses/);
  const short = await runUserCommand(env, ["add", "short@example.com"], "short\n");
  assert.match(short.stderr, /too short/);
  const second = { email: "second@example.com", password: "second long password" };
  assert.equal((await runUserCommand(env, ["add", second.email, "--name=Second"], `${second.password}\n`)).code, 0);
  const listed = await runUserCommand(env, ["list"]);
  assert.match(listed.stdout, /admin@example\.com/);
  assert.match(listed.stdout, /second@example\.com	Second/);

  const secondCookie = await signIn(baseUrl, second);
  const asSecond = () => fetch(`${baseUrl}/api/repos`, { headers: { Cookie: secondCookie } }).then((r) => r.status);
  assert.equal(await asSecond(), 200);
  assert.equal((await runUserCommand(env, ["password", second.email], "a brand new password\n")).code, 0);
  assert.equal(await asSecond(), 401, "changing the password closes the sessions");
  const renewed = await signIn(baseUrl, { email: second.email, password: "a brand new password" });
  assert.equal((await runUserCommand(env, ["remove", second.email])).code, 0);
  assert.equal(await fetch(`${baseUrl}/api/repos`, { headers: { Cookie: renewed } }).then((r) => r.status), 401, "removing the account closes its sessions");

  const temporary = await signIn(baseUrl);
  const signOut = await fetch(`${baseUrl}/api/auth/sign-out`, { method: "POST", headers: { Cookie: temporary, Origin: baseUrl, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(signOut.status, 200);
  assert.equal(await fetch(`${baseUrl}/api/repos`, { headers: { Cookie: temporary } }).then((r) => r.status), 401);
});

test("a new agent token is shown once, with the command that declares the MCP mode", async () => {
  assert.match(token.secret, /^dtk_/);
  assert.equal(token.setupCommand, `npx -y @imenam/mcp-dependabot-tracker --claude-setup-mcp --server_url=http://localhost:${port} --token=${token.secret}`);
  const listed = await call("GET", "agent-tokens");
  assert.deepEqual(listed.json.tokens.map((entry: { name: string; hint: string }) => [entry.name, entry.hint]), [["Tests", token.secret.slice(-4)]]);
  assert.ok(!JSON.stringify(listed.json).includes(token.secret), "the list never holds the token");
  assert.equal((await call("POST", "agent-tokens", { name: " " })).status, 400);

  assert.equal((await call("GET", "agent/repos")).status, 401, "the agent API needs a token");
  assert.equal((await call("GET", "agent/repos", undefined, { Authorization: "Bearer dtk_nope" })).status, 401);
  assert.equal((await call("GET", "agent/repos", undefined, { Authorization: `Bearer ${token.secret}` })).status, 200);
});

test("the GUI adds a repository, syncs its paginated alerts and refuses bad input", async () => {
  const empty = await client.callTool("list_repositories");
  assert.match(empty.text, /No repository is tracked/);

  const added = await call("POST", "repos", { repository: "https://github.com/octo/demo" });
  assert.equal(added.status, 200, added.json.error);
  assert.equal(added.json.repo.id, "octo/demo");
  assert.deepEqual(added.json.repo.alerts.map((alert: { number: number }) => alert.number), [2, 1, 3]);

  assert.equal((await call("POST", "repos", { repository: "octo/demo" })).status, 409);
  assert.equal((await call("POST", "repos", { repository: "octo/missing" })).status, 404);
  assert.equal((await call("POST", "repos", { repository: "not a repo" })).status, 400);
  assert.equal((await call("POST", "repos", {})).status, 400);

  const locked = await call("POST", "repos", { repository: "octo/locked" });
  assert.equal(locked.status, 200);
  assert.match(locked.json.repo.syncError, /Dependabot alerts are disabled/);

  const list = await call("GET", "repos");
  assert.deepEqual(list.json.repos.map((view: { repo: { id: string } }) => view.repo.id), ["octo/demo", "octo/locked"]);

  const addable = await call("GET", "github/repos");
  assert.equal(addable.status, 200, addable.json.error);
  assert.deepEqual(addable.json.repositories.sort(), ["octo/extra-1", "octo/extra-2", "octo/extra-3", "octo/quiet"]);
  const branches = await call("GET", "repos/octo/locked/branches");
  assert.deepEqual(branches.json.branches, ["main", "develop", "release"]);
  assert.equal((await call("PUT", "repos/octo/locked/branch", { branch: "nope" })).status, 404);
  assert.equal((await call("PUT", "repos/octo/locked/branch", {})).status, 400);
  const chosen = await call("PUT", "repos/octo/locked/branch", { branch: "develop" });
  assert.equal(chosen.status, 200, chosen.json.error);
  assert.equal(chosen.json.repo.branch, "develop");
  assert.match((await client.callTool("list_repositories")).text, /octo\/locked \(analysed branch develop; default branch main\)/);

  assert.equal((await call("DELETE", "repos/octo/locked")).status, 200);
  assert.equal((await call("GET", "repos/octo/locked")).status, 404);
});

test("the agent reads the alerts and its arguments are checked", async () => {
  const listed = await client.callTool("list_repositories");
  assert.match(listed.text, /octo\/demo \(analysed branch main, the default one\)/);
  assert.match(listed.text, /Open Dependabot alerts: 3 \(critical 1, high 1, medium 1\)/);

  const alerts = await client.callTool("get_alerts", { repository: "octo/demo" });
  assert.equal(alerts.isError, false, alerts.text);
  assert.match(alerts.text, /- #2 critical simple-git \(npm, package-lock\.json, runtime dependency\): Remote code execution — patched in 9\.0\.0/);
  assert.match((await client.callTool("get_alerts", { repository: "octo/missing" })).text, /Repository "octo\/missing" is not tracked/);
  assert.match((await client.callTool("get_alerts", { repository: "demo" })).text, /"repository" must be owner\/name/);

  const unknownField = await client.callTool("run_audit", { repository: "octo/demo", force: true });
  assert.match(unknownField.text, /Unknown field\(s\): force/);
  const badScope = await client.callTool("run_audit", { repository: "octo/demo", scope: "dev" });
  assert.match(badScope.text, /"scope" must be one of production, all/);
  const noPush = await client.callTool("fix_vulnerabilities", { repository: "octo/demo", push: true });
  assert.match(noPush.text, /Unknown field\(s\): push/);
  assert.match((await client.callTool("get_operation", { operation: "op-unknown" })).text, /Operation "op-unknown" not found/);
});

test("the GUI marks an alert fixed by hand; the agent sees it", async () => {
  const marked = await call("PUT", "repos/octo/demo/alerts/2/handled");
  assert.equal(marked.status, 200, marked.json.error);
  assert.deepEqual(marked.json.repo.handledAlerts.map((mark: { number: number; package: string }) => [mark.number, mark.package]), [[2, "simple-git"]]);
  assert.equal((await call("PUT", "repos/octo/demo/alerts/2/handled")).json.repo.handledAlerts.length, 1, "marking twice keeps one mark");
  assert.equal((await call("PUT", "repos/octo/demo/alerts/99/handled")).status, 404);
  assert.equal((await call("PUT", "repos/octo/demo/alerts/abc/handled")).status, 400);

  const listed = await client.callTool("list_repositories");
  assert.match(listed.text, /Open Dependabot alerts: 2 \(high 1, medium 1\) \+ 1 fixed by hand by the user/);
  assert.match((await client.callTool("get_alerts", { repository: "octo/demo" })).text, /#2 critical simple-git .*fixed by hand by the user on /);

  const restored = await call("DELETE", "repos/octo/demo/alerts/2/handled");
  assert.equal(restored.status, 200, restored.json.error);
  assert.deepEqual(restored.json.repo.handledAlerts, []);
});

test("the GUI files repositories in categories, which the agent can list", async () => {
  const created = await call("POST", "categories", { name: "MCP" });
  assert.equal(created.status, 200, created.json.error);
  assert.equal((await call("POST", "categories", { name: " mcp " })).status, 409);
  assert.equal((await call("POST", "categories", { name: "" })).status, 400);
  const tools = await call("POST", "categories", { name: "Outils" });

  const added = await call("POST", "repos", { repository: "octo/extra-1", categoryId: created.json.id });
  assert.equal(added.status, 200, added.json.error);
  assert.equal(added.json.category.name, "MCP");
  assert.equal((await call("POST", "repos", { repository: "octo/extra-2", categoryId: "missing" })).status, 404);

  const filed = await call("PUT", "repos/octo/demo/category", { categoryId: tools.json.id });
  assert.equal(filed.status, 200, filed.json.error);
  assert.equal(filed.json.repo.categoryId, tools.json.id);
  assert.equal((await call("PUT", "repos/octo/demo/category", { categoryId: "missing" })).status, 404);

  const renamed = await call("PUT", `categories/${created.json.id}`, { name: "Serveurs MCP" });
  assert.equal(renamed.json.name, "Serveurs MCP");
  const list = await call("GET", "repos");
  assert.deepEqual(list.json.categories.map((category: { name: string }) => category.name), ["Outils", "Serveurs MCP"]);

  const inCategory = await client.callTool("list_repositories", { category: "serveurs mcp" });
  assert.match(inCategory.text, /^1 repository in category Serveurs MCP:/);
  assert.match(inCategory.text, /octo\/extra-1[\s\S]*Category: Serveurs MCP/);
  assert.doesNotMatch(inCategory.text, /octo\/demo/);
  assert.match((await client.callTool("list_repositories", { category: "Nope" })).text, /Category "Nope" does not exist \(existing categories: Outils, Serveurs MCP\)/);

  assert.equal((await call("DELETE", `categories/${tools.json.id}`)).status, 200);
  assert.equal((await call("GET", "repos/octo/demo")).json.category, null);
  assert.equal((await call("DELETE", `categories/${tools.json.id}`)).status, 404);
  assert.equal((await call("DELETE", "repos/octo/extra-1")).status, 200);
  assert.equal((await call("DELETE", `categories/${created.json.id}`)).status, 200);
});

test("the GUI syncs every repository now, with the pull requests the tracker opened", async () => {
  github.repos.get("octo/demo")!.alerts.push({ number: 4, severity: "low", package: "debug", summary: "ReDoS in debug" });
  const pull = { repo: "octo/demo", title: "t", base: "main", body: "", state: "open" as const, createdAt: "2026-10-01T09:00:00.000Z" };
  github.pulls.push({ ...pull, number: 900, head: "fix/npm-audit-2026-10-01-090000" }, { ...pull, number: 901, head: "feature/login" });
  const synced = await call("POST", "sync");
  assert.equal(synced.status, 200, synced.json.error);
  const demo = synced.json.repos.find((view: { repo: { id: string } }) => view.repo.id === "octo/demo");
  assert.ok(demo.repo.alerts.some((alert: { number: number }) => alert.number === 4));
  assert.deepEqual(demo.repo.pullRequests.map((pending: { number: number }) => pending.number), [900]);
  assert.match((await client.callTool("list_repositories")).text, /Pull requests opened by the tracker, not merged yet: #900 https:\/\/github\.com\/octo\/demo\/pull\/900/);

  github.repos.get("octo/demo")!.alerts.pop();
  github.pulls.splice(github.pulls.findIndex((candidate) => candidate.number === 900), 2);
  const after = await call("POST", "sync");
  assert.deepEqual(after.json.repos.find((view: { repo: { id: string } }) => view.repo.id === "octo/demo").repo.pullRequests, []);
});

test("the GUI queues repositories one by one or a whole category, and marks them done", async () => {
  const category = await call("POST", "categories", { name: "Queue" });
  assert.equal(category.status, 200, category.json.error);
  assert.equal((await call("POST", "repos", { repository: "octo/extra-3", categoryId: category.json.id })).status, 200);
  assert.equal((await call("POST", "repos", { repository: "octo/extra-2" })).status, 200);
  assert.equal((await call("PUT", "categories/missing/queued")).status, 404);
  const queuedCategory = await call("PUT", `categories/${category.json.id}/queued`);
  assert.equal(queuedCategory.status, 200, queuedCategory.json.error);
  const queuedIds = queuedCategory.json.repos.filter((view: { repo: { queuedAt: string | null } }) => view.repo.queuedAt !== null).map((view: { repo: { id: string } }) => view.repo.id);
  assert.deepEqual(queuedIds, ["octo/extra-3"], "only the repositories of the category join the queue");
  const queued = await call("PUT", "repos/octo/extra-3/queued");
  assert.equal(queued.status, 200, queued.json.error);
  assert.ok(queued.json.repo.queuedAt);
  assert.equal((await call("PUT", "repos/octo/extra-3/queued")).json.repo.queuedAt, queued.json.repo.queuedAt, "queuing twice keeps the first date");
  assert.equal((await call("PUT", "repos/octo/missing/queued")).status, 404);


  const done = await call("DELETE", "repos/octo/extra-3/queued");
  assert.equal(done.status, 200, done.json.error);
  assert.equal(done.json.repo.queuedAt, null);

  const pending = await call("PUT", "repos/octo/extra-3/deploy-pending");
  assert.equal(pending.status, 200, pending.json.error);
  assert.ok(pending.json.repo.deployPendingAt);
  assert.equal((await call("PUT", "repos/octo/extra-3/deploy-pending")).json.repo.deployPendingAt, pending.json.repo.deployPendingAt, "marking twice keeps the first date");
  assert.equal((await call("PUT", "repos/octo/missing/deploy-pending")).status, 404);
  const deployed = await call("DELETE", "repos/octo/extra-3/deploy-pending");
  assert.equal(deployed.status, 200, deployed.json.error);
  assert.equal(deployed.json.repo.deployPendingAt, null);

  assert.equal((await call("PUT", "repos/octo/extra-2/queued")).status, 200);
  assert.equal((await call("PUT", "repos/octo/extra-2/deploy-pending")).status, 200);
  const deprecated = await call("PUT", "repos/octo/extra-2/deprecated");
  assert.equal(deprecated.json.repo.queuedAt, null, "deprecating leaves the queue");
  assert.equal(deprecated.json.repo.deployPendingAt, null, "deprecating drops the deploy mark");
  assert.equal((await call("PUT", "repos/octo/extra-2/queued")).status, 409, "a deprecated repository cannot be queued");
  assert.equal((await call("PUT", "repos/octo/extra-2/deploy-pending")).status, 409, "a deprecated repository cannot be marked to deploy");

  assert.equal((await call("DELETE", "repos/octo/extra-3")).status, 200);
  assert.equal((await call("DELETE", "repos/octo/extra-2")).status, 200);
  assert.equal((await call("DELETE", `categories/${category.json.id}`)).status, 200);
});

test("the GUI deprecates a repository: no sync, no audit, hidden from the agent, until restored", async () => {
  assert.equal((await call("POST", "repos", { repository: "octo/extra-2" })).status, 200);
  const deprecated = await call("PUT", "repos/octo/extra-2/deprecated");
  assert.equal(deprecated.status, 200, deprecated.json.error);
  assert.ok(deprecated.json.repo.deprecatedAt);
  const syncedAt = deprecated.json.repo.syncedAt;
  assert.equal((await call("PUT", "repos/octo/missing/deprecated")).status, 404);

  assert.equal((await call("POST", "sync")).status, 200);
  assert.equal((await call("GET", "repos/octo/extra-2")).json.repo.syncedAt, syncedAt);
  assert.ok(!(await call("GET", "github/repos")).json.repositories.includes("octo/extra-2"));
  assert.doesNotMatch((await client.callTool("list_repositories")).text, /octo\/extra-2/);
  const refused = await client.callTool("get_alerts", { repository: "octo/extra-2" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /octo\/extra-2 is deprecated/);
  assert.equal((await call("POST", "repos/octo/extra-2/operations", { scope: "production" })).status, 409);

  const restored = await call("DELETE", "repos/octo/extra-2/deprecated");
  assert.equal(restored.status, 200, restored.json.error);
  assert.equal(restored.json.repo.deprecatedAt, null);
  assert.notEqual(restored.json.repo.syncedAt, syncedAt);
  assert.match((await client.callTool("list_repositories")).text, /octo\/extra-2/);
  assert.equal((await call("DELETE", "repos/octo/extra-2")).status, 200);
});

test("the GUI audits every repository; the agent sees what Dependabot misses", { skip }, async () => {
  assert.equal((await call("POST", "repos", { repository: "octo/quiet" })).status, 200);
  assert.deepEqual((await call("GET", "audit-all")).json, { auditAll: null });
  assert.equal((await call("POST", "audit-all")).status, 400, "the scope is required");
  assert.equal((await call("POST", "audit-all", { scope: "production" })).status, 400, "the target is required");
  assert.equal((await call("POST", "audit-all", { scope: "production", target: { kind: "category", categoryId: "missing" } })).status, 404);
  const started = await call("POST", "audit-all", { scope: "production", target: { kind: "all" } });
  assert.equal(started.status, 200, started.json.error);
  assert.deepEqual([started.json.auditAll.running, started.json.auditAll.scope, started.json.auditAll.target], [true, "production", { kind: "all" }]);
  assert.equal((await call("POST", "audit-all", { scope: "production", target: { kind: "all" } })).status, 409);
  const finished = await waitFor("the audit of every repository", () => call("GET", "audit-all"), (response) => response.json.auditAll.running === false);
  const { total, done, skipped, failed } = finished.json.auditAll;
  assert.deepEqual({ done, skipped, failed }, { done: total, skipped: [], failed: [] });

  const quiet = (await call("GET", "repos/octo/quiet")).json;
  assert.ok(quiet.auditFindings?.count > 0, JSON.stringify(quiet.auditFindings));
  assert.deepEqual([quiet.latestOperation.baseBranch, quiet.latestOperation.scope], ["main", "production"]);
  assert.match(
    (await client.callTool("list_repositories")).text,
    /octo\/quiet[\s\S]*\(production dependencies\) found \d+ vulnerabilities \(worst: \w+\) on the default branch although Dependabot reports none there/
  );
  assert.equal((await call("DELETE", "repos/octo/quiet")).status, 200);
});

test("the agent starts an audit and follows it to the end", { skip }, async () => {
  const started = await client.callTool("run_audit", { repository: "octo/demo" });
  assert.equal(started.isError, false, started.text);
  assert.match(started.text, /^npm audit of octo\/demo \(branch main\), production dependencies \(operation op-[a-z0-9-]+\): running\./);
  const id = operationId(started.text);
  assert.match((await client.callTool("run_audit", { repository: "octo/demo" })).text, /already in progress on octo\/demo/);

  const done = await settledOperation(id);
  assert.match(done.text, /: done\./);
  assert.match(done.text, /Vulnerabilities: 2 found/);
  assert.match(done.text, new RegExp(`Open in the GUI: http://localhost:${port}#/r/octo/demo/op/${id}`));
  assert.match((await client.callTool("cancel_operation", { operation: id })).text, /is already done/);
});

test("the agent fixes without Claude, to the pull request; the result links to the operation in the GUI", { skip }, async () => {
  const started = await client.callTool("fix_vulnerabilities", { repository: "octo/demo", claude: false });
  assert.equal(started.isError, false, started.text);
  const id = operationId(started.text);

  const fixed = await settledOperation(id);
  assert.equal(fixed.isError, false, fixed.text);
  assert.match(fixed.text, /^Fix of octo\/demo \(branch main\), production dependencies \(operation op-[a-z0-9-]+\): done\./);
  assert.match(fixed.text, /Vulnerabilities: 2 found, 1 left after npm audit fix/);
  assert.match(fixed.text, /nth-check \(\w+, fix needs a major upgrade\)/);
  assert.match(fixed.text, /Pull request #\d+: https:\/\/github\.com\/octo\/demo\/pull\/\d+ \(branch fix\/npm-audit-/);
  assert.doesNotMatch(fixed.text, /Fixes by Claude/);

  const operation = (await call("GET", `operations/${id}`)).json.operation;
  assert.deepEqual([operation.origin, operation.status, operation.steps.repair], ["agent", "done", "skipped"]);
  const repo = await call("GET", "repos/octo/demo");
  assert.equal(repo.json.latestOperation.id, id);
  assert.equal(repo.json.activeOperation, null);
});

test("the agent cancels a running fix", { skip }, async () => {
  const started = await client.callTool("fix_vulnerabilities", { repository: "octo/demo", claude: false });
  const id = operationId(started.text);
  const cancelled = await client.callTool("cancel_operation", { operation: id });
  assert.equal(cancelled.isError, false, cancelled.text);
  assert.match(cancelled.text, /\(cancelling\)/);
  const settled = await settledOperation(id);
  assert.match(settled.text, /: cancelled\./);
});

test("the GUI runs a fix to the pull request without any decision, and the PR tab marks it merged", { skip }, async () => {
  assert.equal((await call("POST", "repos/octo/demo/operations", { scope: "dev" })).status, 400);
  const started = await call("POST", "repos/octo/demo/operations", { scope: "all" });
  assert.equal(started.status, 200, started.json.error);
  const id = started.json.operation.id;
  assert.deepEqual([started.json.operation.origin, started.json.operation.scope], ["user", "all"]);
  assert.equal((await call("POST", "repos/octo/demo/operations", { scope: "all" })).status, 409);

  const read = async () => (await call("GET", `operations/${id}`)).json.operation;
  const done = await waitFor("done", read, (op) => op.status === "done" || op.status === "failed");
  assert.equal(done.status, "done", done.error);
  assert.equal(done.steps.repair, "failed", "Claude is not configured on this server");
  assert.match(done.repair.error, /need the organizer connection and the Claude token/);
  const pull = github.pulls.at(-1)!;
  assert.equal(pull.title, "fix(deps): resolve npm audit vulnerabilities");
  assert.match(pull.body, /^> \[!WARNING\]\n> Claude Code could not fix the remaining vulnerabilities/);
  assert.equal(done.pullRequest.number, pull.number);
  assert.equal((await call("POST", `operations/${id}/cancel`)).status, 409);
  assert.equal((await call("GET", "operations/op-unknown")).status, 404);

  const history = await call("GET", "repos/octo/demo/operations");
  assert.equal(history.status, 200, history.json.error);
  const latest = history.json.operations[0];
  assert.deepEqual([latest.id, latest.status, latest.before, latest.after, latest.claude, latest.pullRequest.number], [id, "done", done.counts.initial, done.counts.afterFix, true, pull.number]);
  assert.ok(!("log" in latest), "the history leaves the log out");
  assert.equal((await call("GET", "repos/octo/unknown/operations")).status, 404);

  const pending = (await call("GET", "repos/octo/demo")).json.repo;
  assert.ok(pending.pullRequests.some((candidate: { number: number }) => candidate.number === pull.number));
  assert.equal((await call("PUT", "repos/octo/demo/merged", {})).status, 400);
  const merged = await call("PUT", "repos/octo/demo/merged", { deploy: true });
  assert.equal(merged.status, 200, merged.json.error);
  assert.deepEqual(merged.json.repo.pullRequests, []);
  assert.ok(merged.json.repo.deployPendingAt, "merged, then to deploy");
  const mergedOnly = await call("PUT", "repos/octo/demo/merged", { deploy: false });
  assert.equal(mergedOnly.json.repo.deployPendingAt, merged.json.repo.deployPendingAt, "merging again keeps the deploy mark");
  assert.equal((await call("PUT", "repos/octo/missing/merged", { deploy: false })).status, 404);

  const operations = async () => (await call("GET", "repos/octo/demo/operations")).json.operations;
  const afterMerge = await waitFor("audit after merge", operations, (ops) => ops[0].id !== id && ops[0].status !== "running");
  assert.equal(afterMerge.length, history.json.operations.length + 1, "a single audit, the second merge had no pull request left");
  assert.deepEqual([afterMerge[0].kind, afterMerge[0].status, afterMerge[0].scope, afterMerge[0].baseBranch], ["audit", "done", "all", "main"], afterMerge[0].error);
});

/** Lance le paquet avec `args` et `env`, et rend son code de sortie et sa sortie d'erreur. */
async function runEntry(args: string[], env: Record<string, string | undefined>): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [SERVER_ENTRY, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stderr };
}

test("the server creates CLONE_DIR at launch and refuses to start without its settings", async () => {
  assert.ok(fs.statSync(path.join(temp.dir, "clones", "nested")).isDirectory());

  const env = { ...baseEnv(), MCP_DATA_DIR: path.join(temp.dir, "data-2") };
  const noToken = await runEntry(["serve"], env);
  assert.deepEqual([noToken.code, /GITHUB_TOKEN is not set/.test(noToken.stderr)], [1, true], noToken.stderr);
  const noClones = await runEntry(["serve"], { ...env, GITHUB_TOKEN: "t" });
  assert.deepEqual([noClones.code, /CLONE_DIR is not set/.test(noClones.stderr)], [1, true], noClones.stderr);
  const clones = { ...env, GITHUB_TOKEN: "t", CLONE_DIR: path.join(temp.dir, "clones-2") };
  const noPort = await runEntry(["serve"], clones);
  assert.deepEqual([noPort.code, /APP_PORT is not set/.test(noPort.stderr)], [1, true], noPort.stderr);
  const noUrl = await runEntry(["serve"], { ...clones, APP_PORT: "1" });
  assert.deepEqual([noUrl.code, /APP_URL is not set/.test(noUrl.stderr)], [1, true], noUrl.stderr);
  const noSecret = await runEntry(["serve"], { ...clones, APP_PORT: "1", APP_URL: "http://localhost:1" });
  assert.deepEqual([noSecret.code, /AUTH_SECRET is not set/.test(noSecret.stderr)], [1, true], noSecret.stderr);
  const exposed = { ...clones, APP_PORT: "1", APP_URL: "http://localhost:1", AUTH_SECRET: TEST_AUTH_SECRET };
  const noVault = await runEntry(["serve"], exposed);
  assert.deepEqual([noVault.code, /VAULT_KEY is not set/.test(noVault.stderr)], [1, true], noVault.stderr);
  const badVault = await runEntry(["serve"], { ...exposed, VAULT_KEY: "short" });
  assert.deepEqual([badVault.code, /VAULT_KEY is not a valid key/.test(badVault.stderr)], [1, true], badVault.stderr);
});

test("the MCP mode refuses to start without the server address or the agent token, and the entry point without a command", async () => {
  const noUrl = await runEntry(["mcp"], { ...baseEnv(), AGENT_TOKEN: "t" });
  assert.deepEqual([noUrl.code, /SERVER_URL is not set/.test(noUrl.stderr)], [1, true], noUrl.stderr);
  const noToken = await runEntry(["mcp"], { ...baseEnv(), SERVER_URL: baseUrl });
  assert.deepEqual([noToken.code, /AGENT_TOKEN is not set/.test(noToken.stderr)], [1, true], noToken.stderr);
  const noCommand = await runEntry([], baseEnv());
  assert.deepEqual([noCommand.code, /Usage :/.test(noCommand.stderr)], [1, true], noCommand.stderr);
});

test("a revoked agent token closes the agent API at once", async () => {
  assert.ok((await call("GET", "agent-tokens")).json.tokens[0].lastUsedAt, "the token records its last use");
  assert.equal((await call("DELETE", `agent-tokens/${token.id}`)).status, 200);
  const refused = await client.callTool("list_repositories");
  assert.equal(refused.isError, true);
  assert.match(refused.text, /This agent token is unknown or was revoked/);
  assert.equal((await call("DELETE", `agent-tokens/${token.id}`)).status, 404);
});

test("nothing from the MCP mode leaks onto stdout outside JSON-RPC", () => {
  assert.deepEqual(client.strayStdout, []);
});

test("sign-in attempts are rate limited per client, whatever IP headers the client sends", async () => {
  const attempt = (headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, ...headers },
      body: JSON.stringify({ email: TEST_USER.email, password: "not the password" }),
    }).then((r) => r.status);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push(await attempt());
  assert.ok(statuses.includes(429), `statuses: ${statuses.join(", ")}`);
  assert.equal(await attempt({ "X-Forwarded-For": "203.0.113.7" }), 429);
  assert.equal(await attempt({ "X-Tracker-Client-Ip": "203.0.113.8" }), 429);
});
