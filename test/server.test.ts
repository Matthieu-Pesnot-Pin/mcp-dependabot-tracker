import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

import { FakeGitHub, LocalRemotes, McpClient, SERVER_ENTRY, VULNERABLE_FIXTURE, baseEnv, freePort, makeTempDir, npmRegistryReachable, waitFor } from "./helpers.js";

/**
 * Serveur MCP réel sur stdio, sa GUI en mode standalone sur un port libre, la
 * fausse API GitHub et des dépôts distants locaux : outils de l'agent, droits
 * et parcours complet de la GUI.
 */

const online = await npmRegistryReachable();
const skip = online ? false : "the npm registry is unreachable: npm audit needs it";

let client: McpClient;
let temp: { dir: string; cleanup: () => void };
let github: FakeGitHub;
let baseUrl = "";
let port = 0;

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}/api/${route}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

before(async () => {
  temp = makeTempDir("tracker-server-");
  github = new FakeGitHub();
  await github.start();
  const remotes = new LocalRemotes(path.join(temp.dir, "remotes"));
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
  baseUrl = `http://127.0.0.1:${port}`;
  client = new McpClient({
    ...baseEnv(),
    MCP_DATA_DIR: path.join(temp.dir, "data"),
    CLONE_DIR: path.join(temp.dir, "clones", "nested"),
    GITHUB_TOKEN: github.token,
    GITHUB_API_URL: github.url,
    GITHUB_SERVER_URL: remotes.serverUrl,
    APP_PORT: String(port),
  });
  await client.initialize("tracker-server-test");
  await waitFor("the GUI worker", () => fetch(`${baseUrl}/proxy/health`).then((r) => r.ok, () => false), (ok) => ok, 20_000);
});

after(async () => {
  await client?.stop();
  await github?.stop();
  temp?.cleanup();
});

test("the server lists its tools and serves the GUI page with its base href", async () => {
  const { tools } = await client.request("tools/list");
  assert.deepEqual(
    tools.map((tool: { name: string }) => tool.name),
    ["list_repositories", "get_alerts", "run_audit", "fix_vulnerabilities", "reconnect_gui"]
  );
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<base href="\/" \/>/);
  const config = await call("GET", "config");
  assert.equal(config.json.githubConfigured, true);
  assert.equal((await call("GET", "nope")).status, 404);
});

test("the GUI adds a repository, syncs its paginated alerts and refuses bad input", async () => {
  const empty = await client.callTool("list_repositories");
  assert.match(empty.text, /No repository is tracked/);

  const added = await call("POST", "repos", { repository: "https://github.com/octo/demo" });
  assert.equal(added.status, 200, added.json.error);
  assert.equal(added.json.repo.id, "octo/demo");
  assert.deepEqual(added.json.repo.rights, { audit: true, fix: false, force: false, push: false });
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

test("the agent reads the alerts and is held to its rights", async () => {
  const listed = await client.callTool("list_repositories");
  assert.match(listed.text, /octo\/demo \(analysed branch main, the default one\)/);
  assert.match(listed.text, /Open Dependabot alerts: 3 \(critical 1, high 1, medium 1\)/);
  assert.match(listed.text, /Agent rights: audit/);

  const alerts = await client.callTool("get_alerts", { repository: "octo/demo" });
  assert.equal(alerts.isError, false, alerts.text);
  assert.match(alerts.text, /- #2 critical simple-git \(npm, package-lock\.json\): Remote code execution — patched in 9\.0\.0/);

  const refused = await client.callTool("fix_vulnerabilities", { repository: "octo/demo" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /not allowed to run npm audit fix on octo\/demo\. Only the user can grant this right, in the GUI\./);

  const unknownField = await client.callTool("run_audit", { repository: "octo/demo", force: true });
  assert.match(unknownField.text, /Unknown field\(s\): force/);

  const rights = await call("PUT", "repos/octo/demo/rights", { rights: { audit: true, fix: true, force: false, push: true } });
  assert.equal(rights.status, 200, rights.json.error);
  const noForce = await client.callTool("fix_vulnerabilities", { repository: "octo/demo", force: true });
  assert.match(noForce.text, /not allowed to run npm audit fix --force/);
  assert.equal((await call("PUT", "repos/octo/demo/rights", { rights: { audit: true } })).status, 400);
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

test("the GUI audits every repository; the agent sees what Dependabot misses", { skip }, async () => {
  assert.equal((await call("POST", "repos", { repository: "octo/quiet" })).status, 200);
  assert.deepEqual((await call("GET", "audit-all")).json, { auditAll: null });
  const started = await call("POST", "audit-all");
  assert.equal(started.status, 200, started.json.error);
  assert.equal(started.json.auditAll.running, true);
  assert.equal((await call("POST", "audit-all")).status, 409);
  const finished = await waitFor("the audit of every repository", () => call("GET", "audit-all"), (response) => response.json.auditAll.running === false);
  const { total, done, skipped, failed } = finished.json.auditAll;
  assert.deepEqual({ done, skipped, failed }, { done: total, skipped: [], failed: [] });

  const quiet = (await call("GET", "repos/octo/quiet")).json;
  assert.ok(quiet.auditFindings?.count > 0, JSON.stringify(quiet.auditFindings));
  assert.equal(quiet.latestOperation.baseBranch, "main");
  assert.match((await client.callTool("list_repositories")).text, /octo\/quiet[\s\S]*found \d+ vulnerabilities \(worst: \w+\) on the default branch although Dependabot reports none/);
  assert.equal((await call("DELETE", "repos/octo/quiet")).status, 200);
});

test("the agent fixes and pushes; the result links to the operation in the GUI", { skip }, async () => {
  const fixed = await client.callTool("fix_vulnerabilities", { repository: "octo/demo", push: true }, 180_000);
  assert.equal(fixed.isError, false, fixed.text);
  assert.match(fixed.text, /^npm audit fix on octo\/demo \(operation op-[a-z0-9-]+\): done\./);
  assert.match(fixed.text, /Vulnerabilities: 2 found, 1 left after npm audit fix/);
  assert.match(fixed.text, /npm audit fix --force would upgrade: nth-check 1\.0\.2 → 3\.0\.1/);
  assert.match(fixed.text, /Pull request #\d+: https:\/\/github\.com\/octo\/demo\/pull\/\d+ \(branch fix\/npm-audit-/);
  const link = new RegExp(`Open in the GUI: http://localhost:${port}#/r/octo/demo/op/(op-[a-z0-9-]+)`).exec(fixed.text);
  assert.ok(link, fixed.text);

  const operation = await call("GET", `operations/${link[1]}`);
  assert.equal(operation.json.operation.origin, "agent");
  assert.equal(operation.json.operation.status, "done");
  const repo = await call("GET", "repos/octo/demo");
  assert.equal(repo.json.latestOperation.id, link[1]);
  assert.equal(repo.json.activeOperation, null);
});

test("the GUI runs a fix through the --force decision to the pull request", { skip }, async () => {
  const started = await call("POST", "repos/octo/demo/operations");
  assert.equal(started.status, 200, started.json.error);
  const id = started.json.operation.id;
  assert.equal(started.json.operation.origin, "user");
  assert.equal((await call("POST", "repos/octo/demo/operations")).status, 409);

  const read = async () => (await call("GET", `operations/${id}`)).json.operation;
  const waitingForce = await waitFor("waiting_force", read, (op) => op.status === "waiting_force" || op.status === "failed");
  assert.equal(waitingForce.status, "waiting_force", waitingForce.error);
  assert.equal((await call("POST", `operations/${id}/push`, { commitMessage: "x" })).status, 409);
  assert.equal((await call("POST", `operations/${id}/force`, {})).status, 400);

  assert.equal((await call("POST", `operations/${id}/force`, { apply: true })).status, 200);
  const waitingPush = await waitFor("waiting_push", read, (op) => op.status === "waiting_push" || op.status === "failed");
  assert.equal(waitingPush.status, "waiting_push", waitingPush.error);

  const home = await call("GET", "repos");
  assert.equal(home.json.repos[0].activeOperation.id, id);

  assert.equal((await call("POST", `operations/${id}/push`, { commitMessage: "fix(deps): from the GUI" })).status, 200);
  const done = await waitFor("done", read, (op) => op.status === "done" || op.status === "failed");
  assert.equal(done.status, "done", done.error);
  assert.equal(done.counts.afterForce, 0);
  const pull = github.pulls.at(-1)!;
  assert.equal(pull.title, "fix(deps): from the GUI");
  assert.equal(done.pullRequest.number, pull.number);
  assert.equal((await call("POST", `operations/${id}/cancel`)).status, 409);
  assert.equal((await call("GET", "operations/op-unknown")).status, 404);
});

test("the server creates CLONE_DIR at launch and refuses to start without it", async () => {
  assert.ok(fs.statSync(path.join(temp.dir, "clones", "nested")).isDirectory());

  const child = spawn(process.execPath, [SERVER_ENTRY], { env: { ...baseEnv(), MCP_DATA_DIR: path.join(temp.dir, "data-2") }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /CLONE_DIR is not set/);
});

test("nothing from the server leaks onto stdout outside JSON-RPC", () => {
  assert.deepEqual(client.strayStdout, []);
});
