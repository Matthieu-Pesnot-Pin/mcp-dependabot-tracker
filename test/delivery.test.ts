import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

import { cancelOperation, retryDelivery, type OperationContext } from "../src/core/operations.js";
import { addRepository } from "../src/core/repos.js";
import { Store } from "../src/core/store.js";
import type { GitHubConfig } from "../src/core/config.js";
import type { Delivery, Operation } from "../shared/schemas/model.schema.js";
import { DEFAULT_SETTINGS } from "../shared/schemas/settings.schema.js";
import { FAKE_CLAUDE, FakeDeliveries, FakeGitHub, fakeCommit, fakeContainers, makeTempDir, waitFor, type FakePull } from "./helpers.js";

/**
 * Suite automatique d'une correction, sans npm : merge de la pull request une
 * fois ses checks verts, puis déploiement, sur la fausse API GitHub et de faux
 * déploiements. Chaque test part d'une correction terminée dont la suite est à
 * reprendre.
 */

let temp: { dir: string; cleanup: () => void };
let github: FakeGitHub;
let deliveries: FakeDeliveries;
let ctx: OperationContext;
const errors: string[] = [];

before(async () => {
  temp = makeTempDir("tracker-delivery-");
  github = new FakeGitHub();
  await github.start();
  deliveries = new FakeDeliveries();
  const config: GitHubConfig = { token: github.token, apiUrl: github.url, serverUrl: `file://${path.join(temp.dir, "no-remote")}` };
  ctx = {
    store: new Store(path.join(temp.dir, "data")),
    githubConfig: () => config,
    cloneDir: () => {
      const dir = path.join(temp.dir, "clones");
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    logError: (message) => errors.push(message),
    settings: () => DEFAULT_SETTINGS,
    claude: { command: FAKE_CLAUDE, home: path.join(temp.dir, "claude") },
    containers: fakeContainers(path.join(temp.dir, "podman.jsonl")),
    deliveries,
    deliveryTiming: { pollMs: 20, graceMs: 150, timeoutMs: 5_000 },
  };
});

after(async () => {
  await github?.stop();
  temp?.cleanup();
  assert.deepEqual(errors, []);
});

let counter = 0;

/** Dépôt suivi avec une pull request ouverte du tracker, et une correction terminée dont la suite vaut `delivery`. */
async function fixedRepo(delivery: Partial<Delivery>): Promise<{ repoId: string; operation: Operation; pull: FakePull }> {
  counter += 1;
  const name = `app-${counter}`;
  github.addRepo("octo", name, "main", []);
  const repoId = `octo/${name}`;
  const head = `fix/deps-audit-2026-11-22-10000${counter}`;
  const createdAt = new Date().toISOString();
  const pull: FakePull = { repo: repoId, title: "fix(deps)", head, base: "main", body: "", number: github.pulls.length + 1, state: "open", merged: false, headSha: fakeCommit(repoId, head), mergeCommit: null, createdAt };
  github.pulls.push(pull);
  await addRepository(ctx.store, ctx.githubConfig(), repoId, null);
  assert.equal(ctx.store.getRepo(repoId).pullRequests.length, 1);
  const operation = ctx.store.createOperation({
    id: `op-delivery-${counter}`,
    repoId,
    kind: "fix",
    origin: "user",
    scope: "production",
    status: "failed",
    createdAt,
    updatedAt: createdAt,
    workDir: null,
    baseBranch: "main",
    cancelRequested: false,
    steps: { clone: "done", audit: "done", fix: "done", repair: "skipped", push: "done" },
    projects: [],
    counts: { initial: 1, afterFix: 0, afterRepair: null },
    found: [],
    remaining: [],
    changes: [],
    commitMessage: "fix(deps)",
    branch: head,
    pullRequest: { number: pull.number, url: `https://github.com/${repoId}/pull/${pull.number}` },
    repair: null,
    delivery: { merge: "failed", deploy: "skipped", checks: null, mergeCommit: null, deploymentId: null, error: "earlier failure", ...delivery },
    error: null,
    log: [],
  });
  return { repoId, operation, pull };
}

function settled(id: string): Promise<Operation> {
  return waitFor(`operation ${id}`, () => ctx.store.getOperation(id), (operation) => operation.status !== "running", 10_000);
}

/** Audit de la branche par défaut lancé après le merge, attendu jusqu'à sa fin (il échoue : le dépôt n'a pas de remote). */
function mergeAudit(repoId: string): Promise<Operation | undefined> {
  return waitFor("the audit after the merge", () => ctx.store.listOperations(repoId).find((operation) => operation.kind === "audit"), (operation) => operation !== undefined && operation.status !== "running", 10_000);
}

test("the merge waits for the checks to pass, then the repository deploys and the merged branch is audited", async () => {
  const { repoId, operation, pull } = await fixedRepo({});
  github.checkRuns.set(pull.headSha, [
    { name: "build", status: "completed", conclusion: "success" },
    { name: "test", status: "in_progress", conclusion: null },
  ]);
  github.statuses.set(pull.headSha, [{ context: "ci/legacy", state: "success" }]);
  const resumed = retryDelivery(ctx, operation.id);
  assert.equal(resumed.status, "running");
  assert.deepEqual([resumed.delivery?.merge, resumed.delivery?.deploy, resumed.delivery?.error], ["pending", "pending", null]);

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(pull.merged, false, "a running check holds the merge");
  github.checkRuns.set(pull.headSha, [
    { name: "build", status: "completed", conclusion: "success" },
    { name: "test", status: "completed", conclusion: "skipped" },
  ]);

  const done = await settled(operation.id);
  assert.equal(done.status, "done", done.delivery?.error ?? "");
  assert.deepEqual(done.delivery, { merge: "done", deploy: "done", checks: 3, mergeCommit: `merge-${pull.number}-merge`, deploymentId: `dep-fake-${deliveries.started.length}`, error: null });
  assert.ok(pull.merged, "the pull request is merged with a merge commit");
  assert.equal(deliveries.started.at(-1), repoId);
  assert.deepEqual(ctx.store.getRepo(repoId).pullRequests, []);
  assert.equal((await mergeAudit(repoId))?.baseBranch, "main");
});

test("a failing check stops the workflow before the merge: the pull request stays pending and nothing deploys", async () => {
  const { repoId, operation, pull } = await fixedRepo({});
  github.checkRuns.set(pull.headSha, [{ name: "lint", status: "completed", conclusion: "success" }]);
  github.statuses.set(pull.headSha, [{ context: "ci/test", state: "failure" }]);
  const before = deliveries.started.length;
  retryDelivery(ctx, operation.id);

  const done = await settled(operation.id);
  assert.equal(done.status, "failed");
  assert.deepEqual([done.delivery?.merge, done.delivery?.deploy], ["failed", "skipped"]);
  assert.match(done.delivery!.error!, /Failed checks: ci\/test/);
  assert.equal(pull.merged, false);
  assert.equal(ctx.store.getRepo(repoId).pullRequests.length, 1, "the pull request stays in « PR en attente »");
  assert.equal(deliveries.started.length, before);
});

test("a pull request without any check is merged once the grace delay is over", async () => {
  const { operation, pull } = await fixedRepo({});
  retryDelivery(ctx, operation.id);
  const done = await settled(operation.id);
  assert.equal(done.status, "done", done.delivery?.error ?? "");
  assert.equal(done.delivery?.checks, 0);
  assert.ok(pull.merged);
  assert.ok(done.log.some((entry) => /No check reported/.test(entry.text)));
  await mergeAudit(operation.repoId);
});

test("a failed deployment marks the repository « to deploy »; resuming deploys again without merging again", async () => {
  const { repoId, operation, pull } = await fixedRepo({});
  github.checkRuns.set(pull.headSha, [{ name: "test", status: "completed", conclusion: "success" }]);
  deliveries.outcome = { status: "failed", error: "Le script s'est arrêté avec le code 1, à la ligne 3." };
  try {
    retryDelivery(ctx, operation.id);
    const failed = await settled(operation.id);
    assert.equal(failed.status, "failed");
    assert.deepEqual([failed.delivery?.merge, failed.delivery?.deploy], ["done", "failed"]);
    assert.equal(failed.delivery?.error, "Le script s'est arrêté avec le code 1, à la ligne 3.");
    assert.notEqual(ctx.store.getRepo(repoId).deployPendingAt, null);
    await mergeAudit(repoId);
  } finally {
    deliveries.outcome = { status: "done", error: null };
  }

  const audits = ctx.store.listOperations(repoId).filter((candidate) => candidate.kind === "audit").length;
  const resumed = retryDelivery(ctx, operation.id);
  assert.deepEqual([resumed.delivery?.merge, resumed.delivery?.deploy], ["done", "pending"]);
  const done = await settled(operation.id);
  assert.equal(done.status, "done", done.delivery?.error ?? "");
  assert.equal(done.delivery?.mergeCommit, `merge-${pull.number}-merge`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ctx.store.listOperations(repoId).filter((candidate) => candidate.kind === "audit").length, audits, "no second audit: the merge happened before");
});

test("cancelling the operation while it waits for the checks leaves the merge to resume", async () => {
  const { operation, pull } = await fixedRepo({});
  github.checkRuns.set(pull.headSha, [{ name: "test", status: "queued", conclusion: null }]);
  retryDelivery(ctx, operation.id);
  await waitFor("the merge step", () => ctx.store.getOperation(operation.id), (current) => current.delivery?.merge === "running");
  cancelOperation(ctx, operation.id);
  const cancelled = await settled(operation.id);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual([cancelled.delivery?.merge, cancelled.delivery?.deploy], ["skipped", "skipped"]);
  assert.equal(pull.merged, false);
});

test("resuming is refused when there is nothing to resume or when the repository cannot deploy", async () => {
  const { operation } = await fixedRepo({ merge: "done", deploy: "done", error: null });
  assert.throws(() => retryDelivery(ctx, operation.id), /already merged and deployed/);

  const other = await fixedRepo({});
  deliveries.blocker = "no deployment script";
  try {
    assert.throws(() => retryDelivery(ctx, other.operation.id), /no deployment script/);
  } finally {
    deliveries.blocker = null;
  }
  ctx.store.updateOperation(other.operation.id, (current) => ({ ...current, delivery: null }));
  assert.throws(() => retryDelivery(ctx, other.operation.id), /no automatic merge and deployment to resume/);
});
