import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

import { cancelOperation, runAgentOperation, runDefaultBranchAudit, startUserFix, type OperationContext } from "../src/core/operations.js";
import { addRepository, listRepoBranches, repoView, setBranch } from "../src/core/repos.js";
import { Store } from "../src/core/store.js";
import type { GitHubConfig } from "../src/core/config.js";
import { refreshReportTask } from "../src/core/repair.js";
import type { Operation } from "../shared/schemas/model.schema.js";
import { DEFAULT_SETTINGS, type Settings } from "../shared/schemas/settings.schema.js";
import { FAKE_CLAUDE, FakeGitHub, FakeOrganizer, LocalRemotes, VULNERABLE_DEV_FIXTURE, VULNERABLE_FIXTURE, makeTempDir, npmRegistryReachable, waitFor } from "./helpers.js";

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
/** Réglages lus par les opérations : Claude n'est configuré que dans les tests qui le règlent. */
let settings: Settings = DEFAULT_SETTINGS;
const errors: string[] = [];

/** Réglages des corrections par Claude avec le faux organizer et le token Claude `claudeToken`. */
function claudeSettings(claudeToken: string, maxMinutes = 5): Settings {
  return {
    organizer: { url: organizer.url, token: organizer.token, space: "Maintenance", owner: organizer.owner.name },
    claude: { token: claudeToken, savedAt: new Date().toISOString() },
    analysis: { maxTurns: 10, maxMinutes },
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
  const operation = await runAgentOperation(ctx, repoId, "audit", { scope: "production", push: false, commitMessage: "x" });
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.equal(operation.origin, "agent");
  assert.deepEqual(operation.projects, ["", "tools"]);
  assert.equal(operation.counts.initial, 4);
  assert.deepEqual(operation.steps, { clone: "done", audit: "done", fix: "skipped", repair: "skipped", push: "skipped" });
  assert.deepEqual(
    operation.remaining.map((v) => `${v.project}:${v.name}:${v.fix}`).sort(),
    [":lodash:available", ":nth-check:major", "tools:lodash:available", "tools:nth-check:major"]
  );
  assert.equal(operation.workDir, null);
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
  const started = startUserFix(ctx, repoId, "production");
  return { repoId, done: await waitStatus(started.id, ["done", "failed", "cancelled"]) };
}

test("a fix from the GUI runs to the pull request without any decision; without Claude, the fixes of npm audit fix are pushed with a warning", { skip }, async () => {
  try {
    const repoId = await newRepo();
    const started = startUserFix(ctx, repoId, "production");
    assert.equal(started.status, "running");
    assert.throws(() => startUserFix(ctx, repoId, "production"), /already in progress/);

    const done = await waitStatus(started.id, ["done", "failed", "cancelled"]);
    assert.equal(done.status, "done", done.error ?? "");
    assert.deepEqual([done.counts.initial, done.counts.afterFix], [4, 2]);
    assert.deepEqual(done.steps, { clone: "done", audit: "done", fix: "done", repair: "failed", push: "done" });
    assert.match(done.repair?.error ?? "", /need the organizer connection and the Claude token/);
    assert.equal(done.workDir, null);

    const branch = done.branch!;
    assert.deepEqual(pushedSubjects(repoId, branch), ["fix(deps): resolve npm audit vulnerabilities", "initial"]);
    const [owner, name] = repoId.split("/");
    assert.match(remotes.log(owner, name, branch).split("\n")[0], /^Tracker Bot <4242\+tracker-bot@users\.noreply\.github\.com>\|/);
    const toolsLock = JSON.parse(remotes.show(owner, name, branch, "tools/package-lock.json"));
    assert.notEqual(toolsLock.packages["node_modules/lodash"].version, "4.17.20");

    const pull = github.pulls.find((candidate) => candidate.repo === repoId)!;
    assert.deepEqual({ head: pull.head, base: pull.base, title: pull.title }, { head: branch, base: "main", title: "fix(deps): resolve npm audit vulnerabilities" });
    assert.match(pull.body, /^> \[!WARNING\]\n> Claude Code could not fix the remaining vulnerabilities: .*\n> This pull request only holds the fixes of `npm audit fix`\./);
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
  const started = startUserFix(ctx, repoId, "production");
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
    assert.ok(allowed.includes("mcp__npm__npm_test") && allowed.includes("mcp__organizer__create_task"));
    assert.ok(!allowed.includes("mcp__organizer__update_task"), "Claude creates its report, it never updates another task");
    assert.ok(!option("--allowedTools").includes("git"), "Claude never runs git");
    assert.deepEqual(JSON.parse(option("--settings")), { permissions: { blockWritesOutsideWorkingDirectories: true } });
    assert.match(call.args[call.args.indexOf("-p") + 1], /titled in French "Rapport de correction — "/);
    const npmTools = fs.readFileSync(path.join(call.home, "npm-tools.txt"), "utf-8");
    assert.match(npmTools, /^\$ npm ls lodash --all  \(in \., exit code \d+\)/, "the npm commands of Claude run through the npm tools of the tracker");
    assert.ok(call.env.includes("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"), "the commands of Claude do not receive its token");
    assert.ok(!call.env.includes("GITHUB_TOKEN"), "Claude Code never receives the GitHub token");
    assert.ok(!fs.existsSync(option("--mcp-config")), "the MCP configuration, which holds the organizer token, is deleted after the session");

    const [owner, name] = repoId.split("/");
    assert.deepEqual(pushedSubjects(repoId, done.branch!), ["fix(deps): apply the fixes by Claude", "fix(deps): resolve npm audit vulnerabilities", "initial"]);
    assert.equal(remotes.show(owner, name, done.branch!, "src/fixed.js"), "// correctif\n");
    assert.throws(() => remotes.show(owner, name, done.branch!, "node_modules/installed.txt"), "node_modules is never committed");
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
    assert.deepEqual(pushedSubjects(repoId, done.branch!), ["fix(deps): resolve npm audit vulnerabilities", "initial"]);
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
      assert.deepEqual(pushedSubjects(repoId, done.branch!), ["fix(deps): resolve npm audit vulnerabilities", "initial"]);
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
    const started = startUserFix(ctx, repoId, "production");
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

test("an agent fix without push reports the changes and pushes nothing", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
  const operation = await runAgentOperation(ctx, repoId, "fix", { scope: "production", push: false, commitMessage: "x" });
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.deepEqual(operation.steps, { clone: "done", audit: "done", fix: "done", repair: "skipped", push: "skipped" });
  assert.deepEqual(operation.changes.map((c) => c.name), ["lodash"]);
  assert.equal(operation.pullRequest, null);
  const [owner, name] = repoId.split("/");
  assert.deepEqual(remotes.branches(owner, name), ["main"]);
});

test("an agent fix with push opens the pull request", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_FIXTURE });
  const operation = await runAgentOperation(ctx, repoId, "fix", { scope: "production", push: true, commitMessage: "chore: audit" });
  assert.equal(operation.status, "done", operation.error ?? "");
  assert.ok(operation.pullRequest);
  assert.equal(operation.origin, "agent");
  assert.equal(github.pulls.find((candidate) => candidate.repo === repoId)?.title, "chore: audit");
});

test("a production fix leaves the devDependencies out, an audit of all dependencies sees them", { skip }, async () => {
  const repoId = await newRepo({ ".": VULNERABLE_DEV_FIXTURE });
  const all = await runAgentOperation(ctx, repoId, "audit", { scope: "all", push: false, commitMessage: "x" });
  assert.equal(all.status, "done", all.error ?? "");
  assert.deepEqual(all.found.map((v) => v.name).sort(), ["lodash", "nth-check"]);

  const fixed = await runAgentOperation(ctx, repoId, "fix", { scope: "production", push: true, commitMessage: "fix: production" });
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

  const operation = await runAgentOperation(ctx, repoId, "fix", { scope: "production", push: true, commitMessage: "fix: develop" });
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

  const operation = await runDefaultBranchAudit(ctx, repoId, "production");
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
    const operation = await runAgentOperation(ctx, repoId, "audit", { scope: "production", push: false, commitMessage: "x" });
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
  const operation = await runAgentOperation(ctx, repoId, "audit", { scope: "production", push: false, commitMessage: "x" });
  assert.equal(operation.status, "failed");
  assert.match(operation.error ?? "", /^git clone failed:/);
});
