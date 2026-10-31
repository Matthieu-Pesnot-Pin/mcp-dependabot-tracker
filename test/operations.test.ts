import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

import { cancelOperation, decideForce, pushOperation, runAgentOperation, runDefaultBranchAudit, startUserFix, type OperationContext } from "../src/core/operations.js";
import { addRepository, listRepoBranches, repoView, setBranch } from "../src/core/repos.js";
import { Store } from "../src/core/store.js";
import type { GitHubConfig } from "../src/core/config.js";
import { refreshAnalysisTask } from "../src/core/analysis.js";
import type { Operation } from "../shared/schemas/model.schema.js";
import { DEFAULT_SETTINGS, type Settings } from "../shared/schemas/settings.schema.js";
import { FAKE_CLAUDE, FakeGitHub, FakeOrganizer, LocalRemotes, VULNERABLE_FIXTURE, makeTempDir, npmRegistryReachable, waitFor } from "./helpers.js";

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
let organizer: FakeOrganizer;
/** Réglages lus par les opérations : l'analyse est désactivée sauf dans les tests qui l'activent. */
let settings: Settings = DEFAULT_SETTINGS;
const errors: string[] = [];

/** Réglages d'une analyse automatique avec le faux organizer et le token Claude `claudeToken`. */
function analysisSettings(claudeToken: string, maxMinutes = 5): Settings {
  return {
    organizer: { url: organizer.url, token: organizer.token, space: "Maintenance", owner: organizer.owner.name },
    claude: { token: claudeToken, savedAt: new Date().toISOString() },
    analysis: { auto: true, maxTurns: 10, maxMinutes },
  };
}

/** Appels reçus par le faux Claude, dans l'ordre. */
function claudeCalls(): { args: string[]; cwd: string; env: string[]; home: string; token: string }[] {
  const file = path.join(temp.dir, "claude", "calls.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

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
  organizer = new FakeOrganizer();
  await organizer.start();
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
    settings: () => settings,
    claude: { command: FAKE_CLAUDE, home: path.join(temp.dir, "claude") },
  };
});

after(async () => {
  await github?.stop();
  await organizer?.stop();
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
  assert.deepEqual(operation.steps, { clone: "done", audit: "done", fix: "skipped", analysis: "skipped", force: "skipped", push: "skipped" });
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

test("the automatic analysis has Claude read the clone, create the organizer task and give its opinion on --force", { skip }, async () => {
  settings = analysisSettings("good-token");
  try {
    const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
    const started = startUserFix(ctx, repoId);
    const waiting = await waitStatus(started.id, ["waiting_force", "failed"]);
    assert.equal(waiting.status, "waiting_force", waiting.error ?? "");
    assert.equal(waiting.steps.analysis, "done", waiting.analysis?.error ?? "");

    const task = organizer.tasks.at(-1)!;
    assert.deepEqual(task.tags, [repoId.split("/")[1]]);
    assert.deepEqual(task.assigneeIds, [organizer.owner.id]);
    assert.deepEqual(waiting.analysis?.task, { key: task.key, title: task.title, url: `${organizer.url}/#/task/${task.id}`, status: "todo" });
    assert.deepEqual(waiting.analysis?.report?.force, { recommended: true, reason: "La v3 garde l'API utilisée." });
    assert.equal(waiting.analysis?.turns, 3);
    assert.deepEqual(waiting.analysis?.activity, ["Read package.json", "nth-check sert à css-select ; la montée majeure est sans risque.", "organizer create_task"]);

    const call = claudeCalls().at(-1)!;
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(path.join(waiting.workDir!, "repo")));
    assert.equal(call.token, "good-token");
    assert.ok(!call.env.includes("GITHUB_TOKEN"), "Claude Code never receives the GitHub token");
    const option = (name: string) => call.args[call.args.indexOf(name) + 1];
    assert.equal(option("--tools"), "Read,Grep,Glob");
    assert.equal(option("--permission-mode"), "dontAsk");
    assert.equal(option("--setting-sources"), "user");
    assert.equal(option("--max-turns"), "10");
    assert.equal(option("--allowedTools"), "mcp__organizer__create_task,mcp__organizer__set_assignees,mcp__organizer__set_tags,mcp__organizer__get_task");
    assert.ok(call.args.includes("--strict-mcp-config"));
    assert.ok(!fs.existsSync(option("--mcp-config")), "the MCP configuration, which holds the organizer token, is deleted after the session");

    assert.equal(repoView(ctx.store, ctx.store.getRepo(repoId)).analysisTask?.key, task.key);
    task.status = "done";
    await refreshAnalysisTask(ctx.store, settings, repoId);
    assert.equal(repoView(ctx.store, ctx.store.getRepo(repoId)).analysisTask, null);
    cancelOperation(ctx, started.id);
  } finally {
    settings = DEFAULT_SETTINGS;
  }
});

test("an analysis whose task misses the tag fails, and the operation still waits for the --force decision", { skip }, async () => {
  settings = analysisSettings("untagged");
  try {
    const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
    const started = startUserFix(ctx, repoId);
    const waiting = await waitStatus(started.id, ["waiting_force", "failed"]);
    assert.equal(waiting.status, "waiting_force", waiting.error ?? "");
    assert.equal(waiting.steps.analysis, "failed");
    assert.match(waiting.analysis?.error ?? "", /^Task MNT-\d+ was created without the tag "demo-\d+"\.$/);
    assert.equal(waiting.analysis?.task, null);
    cancelOperation(ctx, started.id);
  } finally {
    settings = DEFAULT_SETTINGS;
  }
});

test("cancelling an operation during the analysis stops Claude Code", { skip }, async () => {
  settings = analysisSettings("slow");
  try {
    const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
    const started = startUserFix(ctx, repoId);
    await waitFor(
      "the analysis to start",
      () => ctx.store.getOperation(started.id),
      (operation) => (operation.analysis?.activity.length ?? 0) > 0
    );
    cancelOperation(ctx, started.id);
    const cancelled = await waitStatus(started.id, ["cancelled", "failed", "waiting_force"]);
    assert.equal(cancelled.status, "cancelled", cancelled.error ?? "");
    assert.equal(cancelled.steps.analysis, "skipped");
    assert.equal(cancelled.workDir, null);
  } finally {
    settings = DEFAULT_SETTINGS;
  }
});

test("an agent fix without push reports the changes and pushes nothing", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
  const operation = await runAgentOperation(ctx, repoId, "fix", { force: false, push: false, commitMessage: "x" });
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.deepEqual(operation.steps, { clone: "done", audit: "done", fix: "done", analysis: "skipped", force: "skipped", push: "skipped" });
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

test("the audit of the default branch ignores the analysed branch and reports what Dependabot misses", { skip }, async () => {
  counter += 1;
  const name = `demo-${counter}`;
  remotes.create("octo", name, "main", { ".": VULNERABLE_FIXTURE });
  remotes.addBranch("octo", name, "main", "develop");
  github.addRepo("octo", name, "main", [], ["main", "develop"]);
  const repoId = (await addRepository(ctx.store, ctx.githubConfig(), `octo/${name}`, null)).id;
  await setBranch(ctx.store, ctx.githubConfig(), repoId, "develop");

  const operation = await runDefaultBranchAudit(ctx, repoId);
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.deepEqual([operation.kind, operation.origin, operation.baseBranch], ["audit", "user", "main"]);
  assert.equal(operation.found.length, operation.counts.initial);
  const findings = repoView(ctx.store, ctx.store.getRepo(repoId)).auditFindings;
  assert.equal(findings?.count, operation.counts.initial);
  assert.equal(findings?.at, operation.createdAt);
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
