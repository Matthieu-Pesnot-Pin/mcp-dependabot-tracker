import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

import { cancelOperation, decideForce, pushOperation, runAgentOperation, startUserFix, type OperationContext } from "../src/core/operations.js";
import { addRepository, listRepoBranches, setBranch } from "../src/core/repos.js";
import { Store } from "../src/core/store.js";
import type { GitHubConfig } from "../src/core/config.js";
import type { Operation } from "../shared/schemas/model.schema.js";
import { FakeGitHub, LocalRemotes, VULNERABLE_FIXTURE, makeTempDir, npmRegistryReachable, waitFor } from "./helpers.js";

/**
 * Opérations de bout en bout : clone d'un dépôt local par `file://`, vrai
 * `npm audit` (registre npm requis), branche poussée dans le dépôt nu et pull
 * request enregistrée par la fausse API GitHub.
 */

const online = await npmRegistryReachable();
const skip = online ? false : "the npm registry is unreachable: npm audit needs it";

let temp: { dir: string; cleanup: () => void };
let github: FakeGitHub;
let remotes: LocalRemotes;
let ctx: OperationContext;
const errors: string[] = [];

/** Chaque test a son propre dépôt, pour qu'aucune opération n'en bloque une autre. */
let counter = 0;
async function newRepo(files: Record<string, string> = { ".": VULNERABLE_FIXTURE, tools: VULNERABLE_FIXTURE }): Promise<string> {
  counter += 1;
  const name = `demo-${counter}`;
  remotes.create("octo", name, "main", files);
  github.addRepo("octo", name, "main", [{ number: 1, severity: "high", package: "lodash", summary: "Command Injection in lodash" }]);
  return (await addRepository(ctx.store, ctx.githubConfig(), `octo/${name}`, null)).id;
}

function waitStatus(id: string, statuses: Operation["status"][]): Promise<Operation> {
  return waitFor(`operation ${id} in ${statuses.join("|")}`, () => ctx.store.getOperation(id), (operation) => statuses.includes(operation.status));
}

before(async () => {
  temp = makeTempDir("tracker-operations-");
  github = new FakeGitHub();
  await github.start();
  remotes = new LocalRemotes(path.join(temp.dir, "remotes"));
  const config: GitHubConfig = { token: github.token, apiUrl: github.url, serverUrl: remotes.serverUrl };
  ctx = {
    store: new Store(path.join(temp.dir, "data")),
    githubConfig: () => config,
    cloneDir: () => {
      const dir = path.join(temp.dir, "clones");
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    logError: (message) => errors.push(message),
  };
});

after(async () => {
  await github?.stop();
  temp?.cleanup();
  assert.deepEqual(errors, []);
});

test("an agent audit reports the vulnerabilities of every npm project and deletes its clone", { skip }, async () => {
  const repoId = await newRepo();
  const operation = await runAgentOperation(ctx, repoId, "audit", { force: false, push: false, commitMessage: "x" });
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.equal(operation.origin, "agent");
  assert.deepEqual(operation.projects, ["", "tools"]);
  assert.equal(operation.counts.initial, 4);
  assert.deepEqual(operation.steps, { clone: "done", audit: "done", fix: "skipped", force: "skipped", push: "skipped" });
  assert.deepEqual(
    operation.remaining.map((v) => `${v.project}:${v.name}:${v.fix}`).sort(),
    [":lodash:available", ":nth-check:major", "tools:lodash:available", "tools:nth-check:major"]
  );
  assert.equal(operation.workDir, null);
});

test("the GUI flow waits for the --force decision, then pushes a branch and opens the pull request", { skip }, async () => {
  const repoId = await newRepo();
  const started = startUserFix(ctx, repoId);
  assert.equal(started.status, "running");
  assert.throws(() => startUserFix(ctx, repoId), /already in progress/);

  const waitingForce = await waitStatus(started.id, ["waiting_force", "failed"]);
  assert.equal(waitingForce.status, "waiting_force", waitingForce.error ?? "");
  assert.equal(waitingForce.counts.initial, 4);
  assert.equal(waitingForce.counts.afterFix, 2);
  assert.deepEqual(
    waitingForce.forceCandidates.map((c) => `${c.project}:${c.name}:${c.from}->${c.to}`),
    [":nth-check:1.0.2->3.0.1", "tools:nth-check:1.0.2->3.0.1"]
  );
  assert.ok(waitingForce.workDir && fs.existsSync(waitingForce.workDir));
  assert.equal(path.dirname(waitingForce.workDir), path.join(temp.dir, "clones"));
  assert.throws(() => pushOperation(ctx, started.id, "msg"), /is waiting_force, not waiting_push/);

  decideForce(ctx, started.id, true);
  const waitingPush = await waitStatus(started.id, ["waiting_push", "failed"]);
  assert.equal(waitingPush.status, "waiting_push", waitingPush.error ?? "");
  assert.equal(waitingPush.counts.afterForce, 0);
  assert.match(waitingPush.branch ?? "", /^fix\/npm-audit-\d{4}-\d{2}-\d{2}-\d{6}$/);
  const changed = waitingPush.changes.map((c) => `${c.project}:${c.name}`);
  for (const expected of [":lodash", ":nth-check", "tools:lodash", "tools:nth-check"]) assert.ok(changed.includes(expected), `${expected} in ${changed}`);

  pushOperation(ctx, started.id, "fix(deps): bump vulnerable packages");
  const done = await waitStatus(started.id, ["done", "failed"]);
  assert.equal(done.status, "done", done.error ?? "");
  assert.equal(done.steps.push, "done");
  assert.equal(done.workDir, null);
  assert.ok(waitingForce.workDir && !fs.existsSync(waitingForce.workDir));

  const [owner, name] = repoId.split("/");
  const branch = done.branch!;
  assert.ok(remotes.branches(owner, name).includes(branch));
  assert.match(remotes.log(owner, name, branch).split("\n")[0], /^Tracker Bot <4242\+tracker-bot@users\.noreply\.github\.com>\|fix\(deps\): bump vulnerable packages$/);
  const rootManifest = JSON.parse(remotes.show(owner, name, branch, "package.json"));
  assert.match(rootManifest.dependencies["nth-check"], /^\^3\./);
  const toolsLock = JSON.parse(remotes.show(owner, name, branch, "tools/package-lock.json"));
  assert.notEqual(toolsLock.packages["node_modules/lodash"].version, "4.17.20");

  const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
  assert.deepEqual({ head: pull.head, base: pull.base, title: pull.title }, { head: branch, base: "main", title: "fix(deps): bump vulnerable packages" });
  assert.match(pull.body, /Vulnerabilities before: 4/);
  assert.deepEqual(done.pullRequest, { number: pull.number, url: `https://github.com/${repoId}/pull/${pull.number}` });
  assert.deepEqual(
    ctx.store.getRepo(repoId).pullRequests.map((pending) => [pending.number, pending.branch]),
    [[pull.number, branch]],
    "the repository lists the pull request at once, before the next sync"
  );
});

test("skipping --force keeps the major upgrade out, and cancelling a waiting operation deletes its clone", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
  const started = startUserFix(ctx, repoId);
  await waitStatus(started.id, ["waiting_force"]);
  decideForce(ctx, started.id, false);
  const waitingPush = await waitStatus(started.id, ["waiting_push", "failed"]);
  assert.equal(waitingPush.steps.force, "skipped");
  assert.deepEqual(waitingPush.changes.map((c) => c.name), ["lodash"]);

  const cancelled = cancelOperation(ctx, started.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.steps.push, "skipped");
  assert.equal(cancelled.workDir, null);
  assert.ok(!fs.existsSync(waitingPush.workDir!));
  assert.throws(() => cancelOperation(ctx, started.id), /already cancelled/);
});

test("cancelling a running operation stops its command", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
  const started = startUserFix(ctx, repoId);
  const requested = cancelOperation(ctx, started.id);
  assert.equal(requested.cancelRequested, true);
  const cancelled = await waitStatus(started.id, ["cancelled", "failed", "waiting_force"]);
  assert.equal(cancelled.status, "cancelled", cancelled.error ?? "");
  assert.equal(cancelled.workDir, null);
});

test("an agent fix without push reports the changes and pushes nothing", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
  const operation = await runAgentOperation(ctx, repoId, "fix", { force: false, push: false, commitMessage: "x" });
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.deepEqual(operation.steps, { clone: "done", audit: "done", fix: "done", force: "skipped", push: "skipped" });
  assert.equal(operation.forceCandidates.length, 1);
  assert.deepEqual(operation.changes.map((c) => c.name), ["lodash"]);
  assert.equal(operation.pullRequest, null);
  const [owner, name] = repoId.split("/");
  assert.deepEqual(remotes.branches(owner, name), ["main"]);
});

test("an agent fix with force and push opens the pull request", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
  const operation = await runAgentOperation(ctx, repoId, "fix", { force: true, push: true, commitMessage: "chore: audit" });
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.equal(operation.counts.afterForce, 0);
  assert.ok(operation.pullRequest);
  assert.equal(operation.origin, "agent");
});

test("an operation clones the chosen branch and opens the pull request towards it", { skip }, async () => {
  counter += 1;
  const name = `demo-${counter}`;
  remotes.create("octo", name, "main", { ".": VULNERABLE_FIXTURE });
  remotes.addBranch("octo", name, "main", "develop");
  github.addRepo("octo", name, "main", [], ["main", "develop"]);
  const repoId = (await addRepository(ctx.store, ctx.githubConfig(), `octo/${name}`, null)).id;
  assert.equal(ctx.store.getRepo(repoId).branch, "main");
  assert.deepEqual(await listRepoBranches(ctx.store, ctx.githubConfig(), repoId), ["main", "develop"]);
  await assert.rejects(setBranch(ctx.store, ctx.githubConfig(), repoId, "nope"), /Branch "nope" does not exist/);
  await setBranch(ctx.store, ctx.githubConfig(), repoId, "develop");

  const operation = await runAgentOperation(ctx, repoId, "fix", { force: false, push: true, commitMessage: "fix: develop" });
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.equal(operation.baseBranch, "develop");
  const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
  assert.equal(pull.base, "develop");
  assert.ok(remotes.branches("octo", name).includes(operation.branch!));
});

test("a repository without package-lock.json fails with an explicit error", async () => {
  const empty = makeTempDir("tracker-empty-");
  try {
    fs.writeFileSync(path.join(empty.dir, "README.md"), "nothing\n");
    const repoId = await newRepo({ "README.md": path.join(empty.dir, "README.md") });
    const operation = await runAgentOperation(ctx, repoId, "audit", { force: false, push: false, commitMessage: "x" });
    assert.equal(operation.status, "failed");
    assert.equal(operation.steps.clone, "failed");
    assert.match(operation.error ?? "", /No package-lock\.json is tracked in octo\/demo-\d+: npm audit needs a lockfile/);
    assert.equal(operation.workDir, null);
  } finally {
    empty.cleanup();
  }
});

test("a clone of an unknown remote fails and reports git's message", async () => {
  github.addRepo("octo", "ghost", "main", []);
  const repoId = (await addRepository(ctx.store, ctx.githubConfig(), "octo/ghost", null)).id;
  const operation = await runAgentOperation(ctx, repoId, "audit", { force: false, push: false, commitMessage: "x" });
  assert.equal(operation.status, "failed");
  assert.match(operation.error ?? "", /^git clone failed:/);
});
