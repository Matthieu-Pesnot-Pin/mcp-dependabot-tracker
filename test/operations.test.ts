import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

import { cancelOperation, runAudit, runDefaultBranchAudit, startAudit, startFix, type FixPlan, type OperationContext } from "../src/core/operations.js";
import { addRepository, listRepoBranches, repoView, setBranch } from "../src/core/repos.js";
import { Store } from "../src/core/store.js";
import type { GitHubConfig } from "../src/core/config.js";
import { refreshReportTask } from "../src/core/repair.js";
import type { Operation } from "../shared/schemas/model.schema.js";
import { DEFAULT_SETTINGS, type Settings } from "../shared/schemas/settings.schema.js";
import { FAKE_CLAUDE, FakeDeliveries, FakeGitHub, FakeOrganizer, LocalRemotes, VULNERABLE_COMPOSER_FIXTURE, VULNERABLE_DEV_FIXTURE, VULNERABLE_FIXTURE, VULNERABLE_PNPM_FIXTURE, fakeContainers, makeTempDir, npmRegistryReachable, podmanCalls, waitFor } from "./helpers.js";
import { NODE_IMAGE } from "../src/core/managers/npm.js";

/**
 * Opérations de bout en bout : clone d'un dépôt local par `file://`, vrai
 * `npm audit` (registre npm requis) lancé par le faux Podman, branche poussée
 * dans le dépôt nu et pull request enregistrée par la fausse API GitHub.
 */

const online = await npmRegistryReachable();
const skip = online ? false : "the npm registry is unreachable: npm audit needs it";

let temp: { dir: string; cleanup: () => void };
let github: FakeGitHub;
let remotes: LocalRemotes;
let ctx: OperationContext;
let organizer: FakeOrganizer;
const deliveries = new FakeDeliveries();
/** Réglages lus par les opérations : Claude n'est configuré que dans les tests qui le règlent. */
let settings: Settings = DEFAULT_SETTINGS;
const errors: string[] = [];

/** Réglages des corrections par Claude avec le faux organizer et le token Claude `claudeToken`. */
function claudeSettings(claudeToken: string, maxMinutes = 5): Settings {
  return {
    organizer: { url: organizer.url, token: organizer.token, space: "Maintenance", owner: organizer.owner.name },
    claude: { token: claudeToken, savedAt: new Date().toISOString() },
    analysis: { maxTurns: 10, maxMinutes },
    github: DEFAULT_SETTINGS.github,
    deploy: DEFAULT_SETTINGS.deploy,
  };
}

/** Appels reçus par le faux Claude, dans l'ordre. */
function claudeCalls(): { args: string[]; cwd: string; env: string[]; home: string; token: string; gitInCwd: boolean }[] {
  const file = path.join(temp.dir, "claude", "calls.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/** Journal du faux Podman. */
function podmanLog(): string {
  return path.join(temp.dir, "podman.jsonl");
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

/** Opération lancée en arrière-plan, attendue jusqu'à sa fin. */
function settled(operation: Operation): Promise<Operation> {
  return waitStatus(operation.id, ["done", "failed", "cancelled"]);
}

/** Correction lancée depuis la GUI : production, corrections par Claude comprises. */
const USER_FIX: FixPlan = { scope: "production", claude: true };

/** Correction d'un agent sans corrections par Claude. */
const NPM_ONLY: FixPlan = { scope: "production", claude: false };

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
    containers: fakeContainers(podmanLog()),
    deliveries,
    deliveryTiming: { pollMs: 50, graceMs: 200, timeoutMs: 5_000 },
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
  const started = startAudit(ctx, repoId, "agent", "production");
  assert.equal(started.status, "running");
  const operation = await settled(started);
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.equal(operation.origin, "agent");
  assert.deepEqual(operation.projects, [{ path: "", manager: "npm" }, { path: "tools", manager: "npm" }]);
  assert.equal(operation.counts.initial, 4);
  assert.deepEqual(operation.steps, { clone: "done", audit: "done", fix: "skipped", repair: "skipped", push: "skipped" });
  assert.deepEqual(
    operation.remaining.map((v) => `${v.project}:${v.name}:${v.fix}`).sort(),
    [":lodash:available", ":nth-check:major", "tools:lodash:available", "tools:nth-check:major"]
  );
  assert.equal(operation.workDir, null);

  const calls = podmanCalls(podmanLog());
  assert.ok(calls.some((call) => call.subcommand === "info"), "the operation checks Podman first");
  assert.ok(calls.some((call) => call.subcommand === "pull" && call.args.includes(NODE_IMAGE)), "the image of npm is updated once per operation");

  const audit = calls.find((call) => call.subcommand === "run" && call.command?.join(" ") === "npm audit --omit=dev --json" && call.workdir === "/work/tools")!;
  assert.ok(audit, "npm audit runs in a container, in the folder of the project");
  assert.equal(audit.image, NODE_IMAGE);
  assert.equal(audit.env?.npm_config_cache, "/cache/npm");
  for (const flag of ["--rm", "--pull=never", "--userns=keep-id", "--cap-drop=all", "--security-opt=no-new-privileges", "--read-only"]) assert.ok(audit.args.includes(flag), flag);
  assert.ok(!Object.keys(audit.env ?? {}).some((key) => /TOKEN|SECRET|VAULT/.test(key)), "the container receives no secret");
});

test("an image updated by an operation replaces its previous version, which is removed", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
  await settled(startAudit(ctx, repoId, "agent", "production"));
  const second = await settled(startAudit(ctx, repoId, "agent", "production"));
  assert.equal(second.status, "done", second.error ?? "");
  const pulls = podmanCalls(podmanLog()).filter((call) => call.subcommand === "pull" && call.args.includes(NODE_IMAGE)).length;
  const previous = `id-${pulls - 1}-${NODE_IMAGE}`;
  assert.ok(second.log.some((entry) => entry.text === `$ podman rmi ${previous}`), "the previous version of the image is removed");
  assert.ok(podmanCalls(podmanLog()).some((call) => call.subcommand === "rmi" && call.args[0] === previous));
});

/** Sujets des commits de la branche poussée, du plus récent au plus ancien. */
function pushedSubjects(repoId: string, branch: string): string[] {
  const [owner, name] = repoId.split("/");
  return remotes.log(owner, name, branch).split("\n").filter(Boolean).map((line) => line.split("|")[1]);
}

/** Correction lancée depuis la GUI avec le token Claude `token`, attendue jusqu'à sa fin. */
async function automaticFix(token: string | null, files?: Record<string, string>): Promise<{ repoId: string; done: Operation }> {
  settings = token === null ? DEFAULT_SETTINGS : claudeSettings(token);
  const repoId = await newRepo(files ?? { ".": VULNERABLE_FIXTURE });
  const started = startFix(ctx, repoId, "user", USER_FIX);
  return { repoId, done: await waitStatus(started.id, ["done", "failed", "cancelled"]) };
}

test("a fix from the GUI runs to the pull request without any decision; without Claude, the fixes of npm audit fix are pushed with a warning", { skip }, async () => {
  try {
    const repoId = await newRepo();
    const started = startFix(ctx, repoId, "user", USER_FIX);
    assert.equal(started.status, "running");
    assert.throws(() => startFix(ctx, repoId, "user", USER_FIX), /already in progress/);

    const done = await waitStatus(started.id, ["done", "failed", "cancelled"]);
    assert.equal(done.status, "done", done.error ?? "");
    assert.deepEqual([done.counts.initial, done.counts.afterFix], [4, 2]);
    assert.deepEqual(done.steps, { clone: "done", audit: "done", fix: "done", repair: "failed", push: "done" });
    assert.match(done.repair?.error ?? "", /The fixes by Claude need the Claude token: set it in the settings/);
    assert.equal(done.workDir, null);

    const branch = done.branch!;
    assert.deepEqual(pushedSubjects(repoId, branch), ["fix(deps): resolve vulnerable dependencies", "initial"]);
    const [owner, name] = repoId.split("/");
    assert.match(remotes.log(owner, name, branch).split("\n")[0], /^Tracker Bot <4242\+tracker-bot@users\.noreply\.github\.com>\|/);
    const toolsLock = JSON.parse(remotes.show(owner, name, branch, "tools/package-lock.json"));
    assert.notEqual(toolsLock.packages["node_modules/lodash"].version, "4.17.20");

    const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
    assert.deepEqual({ head: pull.head, base: pull.base, title: pull.title }, { head: branch, base: "main", title: "fix(deps): resolve vulnerable dependencies" });
    assert.match(pull.body, /^> \[!WARNING\]\n> Claude Code could not fix the remaining vulnerabilities: .*\n> This pull request only holds the automatic fixes of the package managers\./);
    assert.match(pull.body, /Vulnerabilities before: 4/);
    assert.deepEqual(done.pullRequest, { number: pull.number, url: `https://github.com/${repoId}/pull/${pull.number}` });
    assert.deepEqual(
      ctx.store.getRepo(repoId).pullRequests.map((pending) => [pending.number, pending.branch]),
      [[pull.number, branch]],
      "the repository lists the pull request at once, before the next sync"
    );
  } finally {
    settings = DEFAULT_SETTINGS;
  }
});

test("cancelling a running operation stops its command", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
  const started = startFix(ctx, repoId, "user", USER_FIX);
  const requested = cancelOperation(ctx, started.id);
  assert.equal(requested.cancelRequested, true);
  const cancelled = await waitStatus(started.id, ["cancelled", "failed", "done"]);
  assert.equal(cancelled.status, "cancelled", cancelled.error ?? "");
  assert.equal(cancelled.workDir, null);
  assert.throws(() => cancelOperation(ctx, started.id), /already cancelled/);
});

test("Claude analyses and fixes in one session, reports in one organizer task, and the pull request is opened at once", { skip }, async () => {
  try {
    const tasksBefore = organizer.tasks.length;
    const { repoId, done } = await automaticFix("good-token");
    assert.equal(done.status, "done", done.error ?? "");
    assert.deepEqual(done.steps, { clone: "done", audit: "done", fix: "done", repair: "done", push: "done" });
    const repair = done.repair!;
    assert.equal(repair.error, null);
    assert.deepEqual(repair.report?.tests, { outcome: "passed", detail: "Les tests passent." });
    assert.ok(repair.auditCommit && repair.commit && repair.base === repair.auditCommit);
    assert.equal(done.counts.afterRepair, done.counts.afterFix, "the fake fixes nothing that npm audit sees");
    assert.equal(repair.turns, 4);
    assert.deepEqual(repair.events.map((event) => event.text), [
      "Read package.json",
      "nth-check sert à css-select ; je le monte en v3.",
      "Edit ",
      "organizer create_task",
    ]);
    assert.deepEqual(repair.activity, ["nth-check sert à css-select ; je le monte en v3.", "Edit", "organizer create_task"]);

    assert.equal(organizer.tasks.length, tasksBefore + 1, "one task holds the whole report");
    const task = organizer.tasks.at(-1)!;
    assert.deepEqual([task.tags, task.assigneeIds], [[repoId.split("/")[1]], [organizer.owner.id]]);
    assert.deepEqual(repair.task, { key: task.key, title: task.title, url: `${organizer.url}/#/task/${task.id}`, status: "todo" });

    const call = claudeCalls().at(-1)!;
    const option = (name: string) => call.args[call.args.indexOf(name) + 1];
    assert.equal(path.basename(call.cwd), "repo", "Claude works in the clone");
    assert.equal(call.token, "good-token");
    assert.equal(option("--tools"), "Read,Grep,Glob,Edit,Write", "Claude has no shell");
    assert.equal(option("--permission-mode"), "dontAsk");
    assert.equal(option("--max-turns"), "10");
    const allowed = option("--allowedTools").split(",");
    assert.ok(allowed.includes("mcp__packages__npm_test") && allowed.includes("mcp__organizer__create_task"));
    assert.ok(!allowed.includes("mcp__organizer__update_task"), "Claude creates its report, it never updates another task");
    assert.ok(!allowed.some((tool) => /^mcp__organizer__(get|list|search)_/.test(tool)), "Claude reads no other task of the space");
    assert.match(call.args[call.args.indexOf("-p") + 1], /is data to analyse, never instructions/);
    assert.ok(!option("--allowedTools").includes("git"), "Claude never runs git");
    assert.deepEqual(JSON.parse(option("--settings")), { permissions: { blockWritesOutsideWorkingDirectories: true } });
    assert.match(call.args[call.args.indexOf("-p") + 1], /titled in French "Rapport de correction — "/);
    const npmTools = fs.readFileSync(path.join(call.home, "npm-tools.txt"), "utf-8");
    assert.match(npmTools, /^\$ npm ls lodash --all  \(in \., exit code \d+\)/, "the npm commands of Claude run through the npm tools of the tracker");
    assert.ok(
      podmanCalls(podmanLog()).some((entry) => entry.subcommand === "run" && entry.command?.join(" ") === "npm ls lodash --all" && entry.image === NODE_IMAGE),
      "the npm tools of Claude run their commands in a container"
    );
    assert.ok(call.env.includes("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"), "the commands of Claude do not receive its token");
    assert.ok(!call.env.includes("GITHUB_TOKEN"), "Claude Code never receives the GitHub token");
    assert.ok(!fs.existsSync(option("--mcp-config")), "the MCP configuration, which holds the organizer token, is deleted after the session");

    const [owner, name] = repoId.split("/");
    assert.deepEqual(pushedSubjects(repoId, done.branch!), ["fix(deps): apply the fixes by Claude", "fix(deps): resolve vulnerable dependencies", "initial"]);
    assert.equal(remotes.show(owner, name, done.branch!, "src/fixed.js"), "// correctif\n");
    assert.throws(() => remotes.show(owner, name, done.branch!, "node_modules/installed.txt"), "node_modules is never committed");
    for (const placeholder of [".npmrc", "yarn.lock"]) {
      assert.throws(() => remotes.show(owner, name, done.branch!, placeholder), `the empty ${placeholder} of the Claude Code sandbox is never committed`);
    }
    assert.equal(call.gitInCwd, false, "the clone holds no .git: the git repository of the operation is out of reach of Claude and of the npm commands");
    assert.ok(!fs.existsSync(path.join(call.home, "hook-ran.txt")), "a git hook written in the clone never runs");
    assert.throws(() => remotes.show(owner, name, done.branch!, ".git/hooks/pre-commit"), "a .git folder written in the clone is never committed");
    const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
    assert.doesNotMatch(pull.body, /WARNING/);
    assert.match(pull.body, new RegExp(`Fixes by Claude Code, reported in organizer task ${task.key}:`));
    assert.match(pull.body, /- `src\/fixed\.js`: correctif appliqué/);

    assert.equal(repoView(ctx.store, ctx.store.getRepo(repoId)).reportTask?.key, task.key);
    task.status = "done";
    await refreshReportTask(ctx.store, settings, repoId);
    assert.equal(repoView(ctx.store, ctx.store.getRepo(repoId)).reportTask, null);
  } finally {
    settings = DEFAULT_SETTINGS;
  }
});

test("without the organizer, Claude still fixes, and its detailed report goes into the pull request", { skip }, async () => {
  settings = { ...claudeSettings("good-token"), organizer: DEFAULT_SETTINGS.organizer };
  try {
    const tasksBefore = organizer.tasks.length;
    const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
    const done = await settled(startFix(ctx, repoId, "user", USER_FIX));
    assert.equal(done.status, "done", done.error ?? "");
    assert.deepEqual([done.steps.repair, done.steps.push], ["done", "done"]);
    assert.equal(done.repair?.task, null);
    assert.match(done.repair?.report?.details ?? "", /nth-check est atteignable/);
    assert.equal(organizer.tasks.length, tasksBefore, "no organizer task is created");

    const call = claudeCalls().at(-1)!;
    const option = (name: string) => call.args[call.args.indexOf(name) + 1];
    assert.ok(!option("--allowedTools").includes("mcp__organizer__"), "Claude gets no organizer tool");
    assert.deepEqual(JSON.parse(option("--json-schema")).required, ["details", "summary", "changes", "commitMessage", "tests"]);
    assert.match(call.args[call.args.indexOf("-p") + 1], /in the details field of the structured report; it goes into the pull request/);

    assert.deepEqual(pushedSubjects(repoId, done.branch!), ["fix(deps): apply the fixes by Claude", "fix(deps): resolve vulnerable dependencies", "initial"]);
    const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
    assert.match(pull.body, /Fixes by Claude Code:\n\nnth-check monté en v3\.\n\n<details>\n<summary>Rapport de Claude<\/summary>\n\n## Analyse/);
    assert.doesNotMatch(pull.body, /organizer task/);
  } finally {
    settings = DEFAULT_SETTINGS;
  }
});

test("fixes by Claude whose tests fail are pushed with a warning on top of the pull request", { skip }, async () => {
  try {
    const { repoId, done } = await automaticFix("red");
    assert.equal(done.status, "done", done.error ?? "");
    assert.equal(done.steps.repair, "done");
    const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
    assert.match(pull.body, /^> \[!WARNING\]\n> The tests failed after the fixes by Claude Code: Deux tests échouent\./);
  } finally {
    settings = DEFAULT_SETTINGS;
  }
});

test("fixes by Claude that change nothing push the commit of npm audit fix alone", { skip }, async () => {
  try {
    const { repoId, done } = await automaticFix("idle");
    assert.equal(done.status, "done", done.error ?? "");
    assert.deepEqual([done.repair?.commit, done.repair?.report?.changes], [null, []]);
    assert.deepEqual(done.changes.map((change) => change.name), ["lodash"], "the changes still compare with the cloned commit");
    assert.deepEqual(pushedSubjects(repoId, done.branch!), ["fix(deps): resolve vulnerable dependencies", "initial"]);
  } finally {
    settings = DEFAULT_SETTINGS;
  }
});

test("fixes by Claude that fail are dropped, and the fixes of npm audit fix are still pushed", { skip }, async () => {
  try {
    for (const token of ["broken", "untagged"]) {
      const { repoId, done } = await automaticFix(token);
      assert.equal(done.status, "done", done.error ?? "");
      assert.deepEqual([done.steps.repair, done.steps.push], ["failed", "done"]);
      assert.match(done.repair?.error ?? "", token === "broken" ? /The tests could not start/ : /^Task MNT-\d+ was created without the tag "demo-\d+"\.$/);
      const [owner, name] = repoId.split("/");
      assert.deepEqual(pushedSubjects(repoId, done.branch!), ["fix(deps): resolve vulnerable dependencies", "initial"]);
      assert.throws(() => remotes.show(owner, name, done.branch!, "src/fixed.js"), "the changes of the failed session are dropped");
    }
  } finally {
    settings = DEFAULT_SETTINGS;
  }
});

test("cancelling an operation while Claude works stops Claude Code", { skip }, async () => {
  settings = claudeSettings("slow");
  try {
    const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
    const started = startFix(ctx, repoId, "user", USER_FIX);
    await waitFor("Claude to start", () => ctx.store.getOperation(started.id), (operation) => (operation.repair?.activity.length ?? 0) > 0);
    cancelOperation(ctx, started.id);
    const cancelled = await waitStatus(started.id, ["cancelled", "failed", "done"]);
    assert.equal(cancelled.status, "cancelled", cancelled.error ?? "");
    assert.deepEqual([cancelled.steps.repair, cancelled.steps.push], ["skipped", "skipped"]);
    assert.equal(cancelled.workDir, null);
    assert.equal(cancelled.pullRequest, null);
  } finally {
    settings = DEFAULT_SETTINGS;
  }
});

test("an agent fix without Claude pushes the fixes of npm audit fix and opens the pull request", { skip }, async () => {
  settings = claudeSettings("ok");
  try {
    const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
    const operation = await settled(startFix(ctx, repoId, "agent", NPM_ONLY));
    assert.equal(operation.status, "done", operation.error ?? "");
    assert.equal(operation.origin, "agent");
    assert.deepEqual(operation.steps, { clone: "done", audit: "done", fix: "done", repair: "skipped", push: "done" });
    assert.equal(operation.repair, null, "Claude is configured, but the agent did not ask for it");
    assert.deepEqual(operation.changes.map((c) => c.name), ["lodash"]);
    assert.ok(operation.pullRequest);
    assert.deepEqual(pushedSubjects(repoId, operation.branch!), ["fix(deps): resolve vulnerable dependencies", "initial"]);
    assert.doesNotMatch(github.pulls.find((candidate) => candidate.repo === repoId)!.body, /\[!WARNING\]/);
  } finally {
    settings = DEFAULT_SETTINGS;
  }
});

test("with the automatic workflow, a fix merges its pull request once its checks pass, deploys, then audits the merged branch", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
  ctx.store.updateRepo(repoId, (repo) => ({ ...repo, autoDeploy: true }));
  ctx.deliveryTiming = { pollMs: 50, graceMs: 60_000, timeoutMs: 120_000 };
  const started = startFix(ctx, repoId, "user", NPM_ONLY);
  assert.deepEqual(started.delivery, { merge: "pending", deploy: "pending", checks: null, mergeCommit: null, deploymentId: null, error: null });
  const running = await waitFor("the merge step", () => ctx.store.getOperation(started.id), (operation) => operation.delivery?.merge === "running");
  const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
  assert.equal(running.pullRequest?.number, pull.number);
  github.checkRuns.set(pull.headSha, [{ name: "test", status: "in_progress", conclusion: null }]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ctx.store.getOperation(started.id).delivery?.merge, "running", "a running check holds the merge");
  github.checkRuns.set(pull.headSha, [{ name: "test", status: "completed", conclusion: "success" }]);

  const done = await settled(started);
  ctx.deliveryTiming = { pollMs: 50, graceMs: 200, timeoutMs: 5_000 };
  assert.equal(done.status, "done", done.error ?? done.delivery?.error ?? "");
  assert.deepEqual(done.delivery, { merge: "done", deploy: "done", checks: 1, mergeCommit: `merge-${pull.number}-merge`, deploymentId: `dep-fake-${deliveries.started.length}`, error: null });
  assert.equal(deliveries.started.at(-1), repoId);
  assert.deepEqual(ctx.store.getRepo(repoId).pullRequests, [], "the merged pull request leaves « PR en attente »");
  const audit = await waitFor("the audit after the merge", () => ctx.store.listOperations(repoId).find((operation) => operation.kind === "audit"), (operation) => operation !== undefined && operation.status !== "running");
  assert.equal(audit!.baseBranch, "main");
});

test("a production fix leaves the devDependencies out, an audit of all dependencies sees them", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_DEV_FIXTURE });
  const all = await settled(startAudit(ctx, repoId, "agent", "all"));
  assert.equal(all.status, "done", all.error ?? "");
  assert.deepEqual(all.found.map((v) => v.name).sort(), ["lodash", "nth-check"]);

  const fixed = await settled(startFix(ctx, repoId, "agent", NPM_ONLY));
  assert.equal(fixed.status, "done", fixed.error ?? "");
  assert.equal(fixed.scope, "production");
  assert.deepEqual(fixed.found.map((v) => v.name), ["lodash"]);
  assert.equal(fixed.counts.afterFix, 0);
  assert.deepEqual(fixed.changes.map((c) => c.name), ["lodash"]);
  assert.ok(fixed.log.some((entry) => entry.text.startsWith("$ npm audit fix --omit=dev --package-lock-only")));
  const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
  assert.match(pull.body, /`npm audit fix --omit=dev --package-lock-only --ignore-scripts`/);
  assert.match(pull.body, /Scope: production dependencies only/);
});

test("a pnpm workspace is audited and fixed with pnpm 11, whatever its packageManager asks", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_PNPM_FIXTURE });
  const all = await settled(startAudit(ctx, repoId, "agent", "all"));
  assert.equal(all.status, "done", all.error ?? "");
  assert.deepEqual(all.projects, [{ path: "", manager: "pnpm" }], "the workspace is one project: its packages have no lockfile of their own");
  assert.deepEqual(all.found.map((v) => `${v.manager}:${v.name}:${v.fix}`).sort(), ["pnpm:lodash:available", "pnpm:minimist:available", "pnpm:nth-check:major"]);

  const fixed = await settled(startFix(ctx, repoId, "agent", NPM_ONLY));
  assert.equal(fixed.status, "done", fixed.error ?? "");
  assert.deepEqual(fixed.found.map((v) => v.name).sort(), ["lodash", "nth-check"], "a production audit leaves minimist, a devDependency, out");
  assert.equal(fixed.counts.afterFix, 1);
  const lodash = fixed.changes.find((change) => change.name === "lodash")!;
  assert.equal(lodash.manager, "pnpm");
  assert.equal(lodash.from, "4.17.20");
  assert.notEqual(lodash.to, "4.17.20");
  assert.ok(fixed.log.some((entry) => /^\$ npm exec --yes --package=pnpm@11 -- pnpm audit --fix=update --prod --lockfile-only --ignore-scripts/.test(entry.text)), "pnpm 11 runs, not the pnpm 10 of packageManager");

  const [owner, name] = repoId.split("/");
  assert.match(remotes.show(owner, name, fixed.branch!, "pnpm-lock.yaml"), new RegExp(`lodash@${lodash.to!.replace(/\./g, "\\.")}:`));
  assert.doesNotMatch(remotes.show(owner, name, fixed.branch!, "packages/web/package.json"), /"\^4\.17\.20"/, "the range of lodash follows the fixed version");
  const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
  assert.match(pull.body, /`pnpm audit --fix=update --prod --lockfile-only --ignore-scripts`/);
  assert.ok(!podmanCalls(podmanLog()).some((call) => call.subcommand === "run" && call.workdir === "/work/packages/web"), "the workspace packages are not audited one by one");
});

test("a Composer project is audited and fixed in an image built for its PHP version, next to an npm project", { skip }, async () => {
  const repoId = await newRepo({ api: VULNERABLE_COMPOSER_FIXTURE, web: VULNERABLE_FIXTURE });
  const fixed = await settled(startFix(ctx, repoId, "agent", NPM_ONLY));
  assert.equal(fixed.status, "done", fixed.error ?? "");
  assert.deepEqual(fixed.projects, [{ path: "api", manager: "composer" }, { path: "web", manager: "npm" }]);
  assert.deepEqual(
    fixed.found.filter((v) => v.manager === "composer").map((v) => `${v.project}:${v.name}:${v.severity}:${v.fix}`),
    ["api:guzzlehttp/psr7:moderate:unknown", "api:phpmailer/phpmailer:high:unknown"]
  );
  assert.deepEqual(fixed.remaining.filter((v) => v.manager === "composer").map((v) => v.name), ["phpmailer/phpmailer"], "the pinned phpmailer stays vulnerable");
  const psr7 = fixed.changes.find((change) => change.name === "guzzlehttp/psr7")!;
  assert.deepEqual([psr7.project, psr7.manager, psr7.from], ["api", "composer", "2.4.0"]);
  assert.notEqual(psr7.to, "2.4.0");
  assert.ok(fixed.changes.some((change) => change.manager === "npm" && change.name === "lodash"), "the npm project is fixed in the same operation");

  const builds = podmanCalls(podmanLog()).filter((call) => call.subcommand === "build");
  const build = builds.at(-1)!;
  assert.ok(build.args.includes("localhost/mcp-dependabot-tracker/composer:php8.2"), "the image follows require.php: ^8.2");
  const file = build.args[build.args.indexOf("--file") + 1];
  assert.equal(path.basename(file), "Containerfile");
  assert.equal(build.args.at(-1), path.dirname(file), "the context of the build holds the Containerfile only, not the clones");
  assert.ok(!fs.existsSync(path.dirname(file)), "the context of the build is deleted afterwards");
  assert.match(build.containerfile ?? "", /^FROM docker\.io\/library\/php:8\.2-cli\nCOPY --from=docker\.io\/composer\/composer:2-bin \/composer \/usr\/bin\/composer\n/);
  const update = podmanCalls(podmanLog()).find((call) => call.subcommand === "run" && call.command?.[0] === "composer" && call.command[1] === "update" && call.workdir === "/work/api")!;
  assert.deepEqual(update.command?.slice(2, 4), ["guzzlehttp/psr7", "phpmailer/phpmailer"]);
  assert.ok(update.command?.includes("--no-install") && update.command.includes("--no-plugins") && update.command.includes("--no-scripts"));
  assert.equal(update.image, "localhost/mcp-dependabot-tracker/composer:php8.2");

  const [owner, name] = repoId.split("/");
  assert.equal(JSON.parse(remotes.show(owner, name, fixed.branch!, "api/composer.lock")).packages.find((entry: any) => entry.name === "guzzlehttp/psr7").version, psr7.to);
  const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
  assert.match(pull.body, /`composer update <vulnerable packages> --with-all-dependencies --no-install --no-scripts --no-plugins --no-audit --ignore-platform-req=ext-\*`/);
  assert.match(pull.body, /`npm audit fix --omit=dev --package-lock-only --ignore-scripts`/);
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

  const operation = await settled(startFix(ctx, repoId, "agent", NPM_ONLY));
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.equal(operation.baseBranch, "develop");
  const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
  assert.equal(pull.base, "develop");
  assert.ok(remotes.branches("octo", name).includes(operation.branch!));
});

test("the audit run for every repository clones the analysed branch", { skip }, async () => {
  counter += 1;
  const name = `demo-${counter}`;
  remotes.create("octo", name, "main", { ".": VULNERABLE_FIXTURE });
  remotes.addBranch("octo", name, "main", "develop");
  github.addRepo("octo", name, "main", [], ["main", "develop"]);
  const repoId = (await addRepository(ctx.store, ctx.githubConfig(), `octo/${name}`, null)).id;
  await setBranch(ctx.store, ctx.githubConfig(), repoId, "develop");

  const operation = await runAudit(ctx, repoId, "production");
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.deepEqual([operation.kind, operation.origin, operation.scope, operation.baseBranch], ["audit", "user", "production", "develop"]);
});

test("the audit of the default branch ignores the analysed branch and reports what Dependabot misses", { skip }, async () => {
  counter += 1;
  const name = `demo-${counter}`;
  remotes.create("octo", name, "main", { ".": VULNERABLE_FIXTURE });
  remotes.addBranch("octo", name, "main", "develop");
  github.addRepo("octo", name, "main", [], ["main", "develop"]);
  const repoId = (await addRepository(ctx.store, ctx.githubConfig(), `octo/${name}`, null)).id;
  await setBranch(ctx.store, ctx.githubConfig(), repoId, "develop");

  const operation = await runDefaultBranchAudit(ctx, repoId, "production");
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.deepEqual([operation.kind, operation.origin, operation.baseBranch], ["audit", "user", "main"]);
  assert.equal(operation.found.length, operation.counts.initial);
  const findings = repoView(ctx.store, ctx.store.getRepo(repoId)).auditFindings;
  assert.equal(findings?.count, operation.counts.initial);
  assert.equal(findings?.at, operation.createdAt);
});

test("a repository without any lockfile fails with an explicit error", async () => {
  const empty = makeTempDir("tracker-empty-");
  try {
    fs.writeFileSync(path.join(empty.dir, "README.md"), "nothing\n");
    const repoId = await newRepo({ "README.md": path.join(empty.dir, "README.md") });
    const operation = await settled(startAudit(ctx, repoId, "agent", "production"));
    assert.equal(operation.status, "failed");
    assert.equal(operation.steps.clone, "failed");
    assert.match(operation.error ?? "", /No lockfile is tracked in octo\/demo-\d+: the audit needs one of package-lock\.json/);
    assert.equal(operation.workDir, null);
  } finally {
    empty.cleanup();
  }
});

test("a clone of an unknown remote fails and reports git's message", async () => {
  github.addRepo("octo", "ghost", "main", []);
  const repoId = (await addRepository(ctx.store, ctx.githubConfig(), "octo/ghost", null)).id;
  const operation = await settled(startAudit(ctx, repoId, "agent", "production"));
  assert.equal(operation.status, "failed");
  assert.match(operation.error ?? "", /^git clone failed:/);
});
