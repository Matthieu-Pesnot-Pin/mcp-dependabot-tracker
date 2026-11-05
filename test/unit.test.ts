import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseRepoRef } from "../src/core/repo-ref.js";
import { nextPageUrl } from "../src/core/github.js";
import { diffLockfiles, parseAuditReport, parseLockfile, parseNpmJson } from "../src/core/npm-audit.js";
import { branchName, isTrackerBranch, mergeAuditScope } from "../src/core/operations.js";
import { runCommand } from "../src/core/commands.js";
import { MAX_SUGGESTIONS, searchRepositories } from "../shared/repo-search.js";
import { AuditAll } from "../src/core/audit-all.js";
import { ConflictError } from "../src/core/errors.js";
import { auditFindings, auditTargetRepos, cleanAudit, cleanProductionAudit, lastAudit, queuedRepos, operationSummary, pruneHandledAlerts, sortAlerts, sortRepos, staleRepos, trackerPullRequests, unfixablePackages } from "../src/core/repos.js";
import { Store } from "../src/core/store.js";
import { parseGuiExposure, runSetupMcp } from "../src/cli/setup-mcp.js";
import { describeOperation } from "../src/tools/format.js";
import { assertSandboxAvailable } from "../src/core/repair.js";
import { bwrapArgs, projectDir } from "../src/core/npm-sandbox.js";
import { npmArgs } from "../src/npm-tools.js";
import { organizerUrl } from "../src/core/organizer.js";
import { readSettings, saveSettings, type SettingsChecks } from "../src/core/settings.js";
import { DEFAULT_RIGHTS, type Alert, type Operation, type Repo } from "../shared/schemas/model.schema.js";
import { DEFAULT_SETTINGS } from "../shared/schemas/settings.schema.js";
import { makeTempDir } from "./helpers.js";

function alert(number: number, severity: Alert["severity"], pkg: string, scope: Alert["scope"] = "runtime"): Alert {
  return { number, severity, ecosystem: "npm", package: pkg, manifestPath: "package-lock.json", summary: "s", url: "u", patchedVersion: null, createdAt: "2026-01-01T00:00:00.000Z", scope };
}

function repo(id: string, alerts: Alert[] = [], syncedAt: string | null = null): Repo {
  const [owner, name] = id.split("/");
  return { id, owner, name, defaultBranch: "main", branch: "main", categoryId: null, addedAt: "2026-01-01T00:00:00.000Z", rights: DEFAULT_RIGHTS, alerts, handledAlerts: [], pullRequests: [], syncedAt, syncError: null, deprecatedAt: null, queuedAt: null, deployPendingAt: null };
}

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-1",
    repoId: "octo/demo",
    kind: "fix",
    origin: "user",
    scope: "production",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pid: process.pid,
    workDir: null,
    baseBranch: "main",
    cancelRequested: false,
    steps: { clone: "pending", audit: "pending", fix: "pending", repair: "pending", push: "pending" },
    projects: [],
    counts: { initial: null, afterFix: null, afterRepair: null },
    remaining: [],
    found: [],
    changes: [],
    commitMessage: "fix",
    branch: null,
    pullRequest: null,
    repair: null,
    error: null,
    log: [],
    ...overrides,
  };
}

test("parseRepoRef reads owner/name, web links and clone URLs", () => {
  assert.deepEqual(parseRepoRef("Imena/mcp-documentor"), { owner: "Imena", name: "mcp-documentor" });
  assert.deepEqual(parseRepoRef("https://github.com/Imena/mcp-documentor/security/dependabot"), { owner: "Imena", name: "mcp-documentor" });
  assert.deepEqual(parseRepoRef("https://github.com/Imena/repo.js.git"), { owner: "Imena", name: "repo.js" });
  assert.deepEqual(parseRepoRef("git@github.com:Imena/x_y.git"), { owner: "Imena", name: "x_y" });
  assert.throws(() => parseRepoRef("mcp-documentor"), /not a GitHub repository/);
  assert.throws(() => parseRepoRef("a/b c"), /not a GitHub repository/);
  assert.throws(() => parseRepoRef("owner/.."), /not a GitHub repository/);
});

test("searchRepositories ranks name prefixes first and caps the suggestions", () => {
  const repositories = ["Imena/mcp-design", "Imena/proxy-setup", "Other/old-mcp-tool", "Imena/mcp-telegram", "mcp-org/website"];
  assert.deepEqual(searchRepositories(repositories, "MCP"), ["Imena/mcp-design", "Imena/mcp-telegram", "mcp-org/website", "Other/old-mcp-tool"]);
  assert.deepEqual(searchRepositories(repositories, "imena/p"), ["Imena/proxy-setup"]);
  assert.deepEqual(searchRepositories(repositories, "  "), []);
  const many = Array.from({ length: 30 }, (_, index) => `o/repo-${String(index).padStart(2, "0")}`);
  assert.equal(searchRepositories(many, "repo").length, MAX_SUGGESTIONS);
});

test("nextPageUrl follows rel=next and stops without it", () => {
  assert.equal(nextPageUrl('<https://api.github.com/x?after=Y2>; rel="next", <https://api.github.com/x?before=Y1>; rel="prev"'), "https://api.github.com/x?after=Y2");
  assert.equal(nextPageUrl('<https://api.github.com/x?before=Y1>; rel="prev"'), null);
  assert.equal(nextPageUrl(null), null);
});

const REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: { name: "lodash", severity: "high", fixAvailable: true },
    "nth-check": { name: "nth-check", severity: "high", fixAvailable: { name: "nth-check", version: "3.0.1", isSemVerMajor: true } },
    "css-select": { name: "css-select", severity: "moderate", fixAvailable: { name: "nth-check", version: "3.0.1", isSemVerMajor: true } },
    request: { name: "request", severity: "moderate", fixAvailable: false },
    dompurify: { name: "dompurify", severity: "low", fixAvailable: { name: "mermaid", version: "10.9.8", isSemVerMajor: false } },
  },
  metadata: {},
};

test("parseAuditReport classifies the fix npm proposes", () => {
  const vulnerabilities = parseAuditReport(REPORT, "gui");
  assert.deepEqual(
    vulnerabilities.map((v) => [v.project, v.name, v.severity, v.fix]),
    [
      ["gui", "lodash", "high", "available"],
      ["gui", "nth-check", "high", "major"],
      ["gui", "css-select", "moderate", "major"],
      ["gui", "request", "moderate", "none"],
      ["gui", "dompurify", "low", "available"],
    ]
  );
  assert.throws(() => parseAuditReport({ auditVersion: 1 }, ""), /auditReportVersion 2/);
});

test("parseNpmJson surfaces npm errors and non-JSON output", () => {
  assert.throws(() => parseNpmJson('{"error":{"summary":"This command requires an existing lockfile.","detail":"Try creating one first."}}', "", "npm audit"), /npm audit failed: This command requires an existing lockfile. Try creating one first./);
  assert.throws(() => parseNpmJson("npm ERR! boom", "stderr text", "npm audit"), /did not return JSON: stderr text/);
  assert.deepEqual(parseNpmJson('{"ok":1}', "", "npm"), { ok: 1 });
});

test("diffLockfiles lists changed, added and removed packages", () => {
  const before = { packages: { "": { version: "1.0.0" }, "node_modules/a": { version: "1.0.0" }, "node_modules/b": { version: "2.0.0" }, "node_modules/c": { version: "1.0.0" } } };
  const after = { packages: { "": { version: "1.0.0" }, "node_modules/a": { version: "1.1.0" }, "node_modules/b": { version: "2.0.0" }, "node_modules/x/node_modules/d": { version: "3.0.0" } } };
  assert.deepEqual(diffLockfiles(before, after, ""), [
    { project: "", name: "a", from: "1.0.0", to: "1.1.0" },
    { project: "", name: "c", from: "1.0.0", to: null },
    { project: "", name: "x/node_modules/d", from: null, to: "3.0.0" },
  ]);
  assert.throws(() => parseLockfile('{"lockfileVersion":1,"dependencies":{}}', "gui"), /gui\/package-lock.json has no "packages" section/);
});

test("commands run without GITHUB_TOKEN in their environment", async () => {
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "secret-token";
  try {
    const result = await runCommand("git", ["-c", "alias.showtoken=!echo token=[$GITHUB_TOKEN]", "showtoken"], { cwd: process.cwd() });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "token=[]");
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

test("branchName encodes the local date and time down to the second", () => {
  assert.equal(branchName(new Date(2026, 9, 28, 14, 32, 5)), "fix/npm-audit-2026-10-28-143205");
});

test("trackerPullRequests keeps the open pull requests of the tracker's own branches", () => {
  const pull = (number: number, branch: string, headRepo: string | null = "Octo/Demo") => ({ number, url: `u${number}`, branch, headRepo, createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(isTrackerBranch("fix/npm-audit-2026-10-28-143205"), true);
  assert.equal(isTrackerBranch("fix/npm-audit-manual"), false);
  const kept = trackerPullRequests("octo/demo", [
    pull(9, "fix/npm-audit-2026-10-28-143205"),
    pull(3, "fix/npm-audit-2026-10-01-090000"),
    pull(4, "feature/login"),
    pull(5, "fix/npm-audit-2026-10-02-090000", "someone/demo"),
    pull(6, "fix/npm-audit-2026-10-03-090000", null),
  ]);
  assert.deepEqual(kept, [
    { number: 3, url: "u3", branch: "fix/npm-audit-2026-10-01-090000", createdAt: "2026-01-01T00:00:00Z" },
    { number: 9, url: "u9", branch: "fix/npm-audit-2026-10-28-143205", createdAt: "2026-01-01T00:00:00Z" },
  ]);
});

test("repositories sort by worst severity, then alert count; alerts by severity then package", () => {
  const views = [
    { repo: repo("o/clean") },
    { repo: repo("o/high", [alert(1, "high", "a"), alert(2, "high", "b"), alert(3, "low", "c")]) },
    { repo: repo("o/critical", [alert(1, "critical", "a")]) },
    { repo: repo("o/high-one", [alert(1, "high", "a")]) },
  ];
  assert.deepEqual(sortRepos(views).map((view) => view.repo.id), ["o/critical", "o/high", "o/high-one", "o/clean"]);
  assert.deepEqual(sortAlerts([alert(3, "low", "z"), alert(1, "critical", "b"), alert(2, "critical", "a")]).map((a) => a.number), [2, 1, 3]);
});

test("cleanAudit reports an audit without vulnerability on the default branch, newer than every alert in its scope", () => {
  const alerted = repo("octo/demo", [alert(1, "high", "lodash")]);
  const clean = (overrides: Partial<Operation> = {}) =>
    operation({ status: "done", createdAt: "2026-03-01T10:00:00.000Z", steps: { clone: "done", audit: "done", fix: "skipped", repair: "skipped", push: "skipped" }, counts: { initial: 0, afterFix: null, afterRepair: null }, ...overrides });
  const stamp = { at: "2026-03-01T10:00:00.000Z", scope: "production" };

  assert.deepEqual(cleanAudit(alerted, [clean()]), stamp);
  assert.equal(cleanAudit(repo("octo/demo"), [clean()]), null, "no alert, nothing to explain");
  assert.equal(cleanAudit(alerted, [clean({ counts: { initial: 2, afterFix: 0, afterRepair: null } })]), null, "the audit found vulnerabilities");
  assert.equal(cleanAudit(alerted, [clean({ baseBranch: "develop" })]), null, "Dependabot only covers the default branch");
  const newer = repo("octo/demo", [alert(1, "high", "lodash"), { ...alert(2, "critical", "tar"), createdAt: "2026-03-02T08:00:00.000Z" }]);
  assert.equal(cleanAudit(newer, [clean()]), null, "an alert emitted after the audit");
  const running = operation({ id: "op-2", createdAt: "2026-03-03T10:00:00.000Z", steps: { clone: "running", audit: "pending", fix: "pending", repair: "pending", push: "pending" } });
  assert.deepEqual(cleanAudit(alerted, [running, clean()]), stamp, "an operation still auditing does not count");
  const dirty = clean({ id: "op-3", createdAt: "2026-03-04T10:00:00.000Z", counts: { initial: 1, afterFix: 1, afterRepair: null } });
  assert.equal(cleanAudit(alerted, [dirty, clean()]), null, "the latest audit decides");

  const development = repo("octo/demo", [alert(1, "high", "lodash"), { ...alert(2, "critical", "vite", "development"), createdAt: "2026-03-02T08:00:00.000Z" }]);
  assert.deepEqual(cleanAudit(development, [clean()]), stamp, "a production audit leaves the alerts on development dependencies aside");
  assert.equal(cleanAudit(development, [clean({ scope: "all" })]), null, "an audit of every dependency answers for them too");
  assert.equal(cleanAudit(repo("octo/demo", [alert(2, "critical", "vite", "development")]), [clean()]), null, "no alert in the scope of the audit");
  assert.deepEqual(cleanAudit(repo("octo/demo", [alert(1, "high", "lodash", null)]), [clean()]), stamp, "an alert of unknown scope counts as a production one");
});

test("cleanProductionAudit reports a clean production audit of the default branch when every alert is on a development dependency", () => {
  const devOnly = repo("octo/demo", [alert(1, "high", "vite", "development")]);
  const clean = (overrides: Partial<Operation> = {}) =>
    operation({ status: "done", createdAt: "2026-03-01T10:00:00.000Z", steps: { clone: "done", audit: "done", fix: "skipped", repair: "skipped", push: "skipped" }, counts: { initial: 0, afterFix: null, afterRepair: null }, ...overrides });
  const stamp = { at: "2026-03-01T10:00:00.000Z", scope: "production" };

  assert.deepEqual(cleanProductionAudit(devOnly, [clean()]), stamp);
  assert.equal(cleanProductionAudit(repo("octo/demo"), [clean()]), null, "no alert, nothing to explain");
  assert.equal(cleanProductionAudit(repo("octo/demo", [alert(1, "high", "vite", "development"), alert(2, "high", "lodash")]), [clean()]), null, "an alert on a production dependency");
  assert.equal(cleanProductionAudit(devOnly, [clean({ scope: "all" })]), null, "an audit of every dependency");
  assert.equal(cleanProductionAudit(devOnly, [clean({ baseBranch: "develop" })]), null, "Dependabot only covers the default branch");
  assert.equal(cleanProductionAudit(devOnly, [clean({ counts: { initial: 1, afterFix: 1, afterRepair: null } })]), null, "the audit found vulnerabilities");
});

test("auditFindings reports what the latest audit of the default branch found while Dependabot reports nothing", () => {
  const audited = (overrides: Partial<Operation> = {}) =>
    operation({
      status: "done",
      createdAt: "2026-03-01T10:00:00.000Z",
      steps: { clone: "done", audit: "done", fix: "skipped", repair: "skipped", push: "skipped" },
      counts: { initial: 2, afterFix: null, afterRepair: null },
      found: [
        { project: "", name: "lodash", severity: "moderate", fix: "available" },
        { project: "", name: "tar", severity: "high", fix: "none" },
      ],
      ...overrides,
    });
  const quiet = repo("octo/demo");
  assert.deepEqual(auditFindings(quiet, [audited()]), { at: "2026-03-01T10:00:00.000Z", scope: "production", count: 2, severity: "high" });
  const development = repo("octo/demo", [alert(1, "high", "vite", "development")]);
  assert.equal(auditFindings(development, [audited()])?.count, 2, "Dependabot only reports development dependencies, out of a production audit");
  assert.equal(auditFindings(development, [audited({ scope: "all" })]), null, "Dependabot reports alerts in the scope of the audit");
  assert.equal(auditFindings(repo("octo/demo", [alert(1, "high", "lodash")]), [audited()]), null, "Dependabot reports alerts");
  assert.equal(auditFindings(quiet, [audited({ found: [], counts: { initial: 0, afterFix: null, afterRepair: null } })]), null, "a clean audit");
  const develop = audited({ id: "op-2", createdAt: "2026-03-02T10:00:00.000Z", baseBranch: "develop", found: [] });
  assert.deepEqual(auditFindings(quiet, [develop, audited()])?.count, 2, "an audit of another branch does not count");
  const fixed = audited({ id: "op-3", kind: "fix", createdAt: "2026-03-03T10:00:00.000Z", remaining: [] });
  assert.deepEqual(auditFindings(quiet, [fixed])?.severity, "high", "a fix reports what its first audit found");
  const views = [{ repo: repo("o/alerted", [alert(1, "medium", "a")]) }, { repo: quiet, auditFindings: auditFindings(quiet, [audited()]) }, { repo: repo("o/clean") }];
  assert.deepEqual(sortRepos(views).map((view) => view.repo.id), ["octo/demo", "o/alerted", "o/clean"]);
});

test("lastAudit sums up the latest audit, whatever its branch", () => {
  const audited = (overrides: Partial<Operation> = {}) =>
    operation({
      status: "done",
      createdAt: "2026-03-01T10:00:00.000Z",
      steps: { clone: "done", audit: "done", fix: "skipped", repair: "skipped", push: "skipped" },
      found: [
        { project: "", name: "lodash", severity: "moderate", fix: "available" },
        { project: "", name: "tar", severity: "high", fix: "none" },
      ],
      ...overrides,
    });
  assert.equal(lastAudit([]), null, "no audit");
  assert.deepEqual(lastAudit([audited()]), { at: "2026-03-01T10:00:00.000Z", scope: "production", branch: "main", afterFix: false, count: 2, severity: "high" });
  const develop = audited({ id: "op-2", createdAt: "2026-03-02T10:00:00.000Z", baseBranch: "develop", found: [] });
  assert.deepEqual(lastAudit([develop, audited()]), { at: "2026-03-02T10:00:00.000Z", scope: "production", branch: "develop", afterFix: false, count: 0, severity: null });
  const running = audited({ id: "op-3", status: "running", steps: { clone: "done", audit: "running", fix: "pending", repair: "pending", push: "pending" } });
  assert.equal(lastAudit([running, audited()])?.count, 2, "an audit still running does not count");
  const fixed = audited({
    id: "op-4",
    kind: "fix",
    updatedAt: "2026-03-01T10:20:00.000Z",
    remaining: [{ project: "", name: "tar", severity: "low", fix: "none" }],
    branch: "fix/npm-audit-2026-03-01-100000",
    pullRequest: { number: 12, url: "https://github.com/octo/demo/pull/12" },
  });
  assert.deepEqual(
    lastAudit([fixed]),
    { at: "2026-03-01T10:20:00.000Z", scope: "production", branch: "fix/npm-audit-2026-03-01-100000", afterFix: true, count: 1, severity: "low" },
    "a fix that opened a pull request reports the audit after its fixes"
  );
  assert.equal(lastAudit([{ ...fixed, pullRequest: null }])?.count, 2, "a fix without pull request changed nothing on GitHub");
});

test("mergeAuditScope audits a merge on the scope of the fix that opened the pull request", () => {
  const fix = (id: string, number: number, scope: Operation["scope"]) => operation({ id, status: "done", scope, pullRequest: { number, url: `https://github.com/octo/demo/pull/${number}` } });
  const operations = [fix("op-3", 14, "production"), fix("op-2", 12, "all"), operation({ id: "op-1", status: "done", scope: "production" })];
  assert.equal(mergeAuditScope(operations, [12]), "all");
  assert.equal(mergeAuditScope(operations, [12, 14]), "production", "the most recent fix wins");
  assert.equal(mergeAuditScope(operations, [99]), "production", "a pull request opened by no recorded operation");
});

test("AuditAll audits three repositories at a time and reports those skipped or failed", async () => {
  let running = 0;
  let peak = 0;
  const scopes = new Set<string>();
  const audit = async (repoId: string, scope: Operation["scope"]): Promise<Operation> => {
    scopes.add(scope);
    if (repoId === "o/busy") throw new ConflictError("An operation is already in progress");
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    return operation({ repoId, status: repoId === "o/broken" ? "failed" : "done", error: repoId === "o/broken" ? "No package-lock.json" : null });
  };
  const errors: string[] = [];
  const auditAll = new AuditAll(audit, (message) => errors.push(message));
  assert.equal(auditAll.status(), null);
  const ids = ["o/a", "o/busy", "o/b", "o/broken", "o/c", "o/d"];
  const started = auditAll.start(ids, "all", { kind: "all" });
  assert.deepEqual([started.running, started.scope, started.target, started.total, started.done], [true, "all", { kind: "all" }, 6, 0]);
  assert.throws(() => auditAll.start(ids, "production", { kind: "all" }), /already running/);
  await auditAll.finished();
  const done = auditAll.status()!;
  assert.equal(done.running, false);
  assert.equal(done.done, 6);
  assert.ok(done.finishedAt);
  assert.deepEqual(done.skipped, ["o/busy"]);
  assert.deepEqual(done.failed, [{ repoId: "o/broken", error: "No package-lock.json" }]);
  assert.equal(peak, 3);
  assert.deepEqual([...scopes], ["all"]);
  assert.deepEqual(errors, []);
});

test("a mark of an alert fixed by hand drops when that alert closes or its package gets a newer alert", () => {
  const mark = (number: number, pkg: string) => ({ number, package: pkg, markedAt: "2026-03-01T10:00:00.000Z" });
  const xlsx = alert(1, "high", "xlsx");
  const lodash = alert(2, "high", "lodash");
  const marks = [mark(1, "xlsx"), mark(2, "lodash")];

  assert.deepEqual(pruneHandledAlerts(marks, [xlsx, lodash]), marks);
  assert.deepEqual(pruneHandledAlerts(marks, [lodash]).map((kept) => kept.number), [2], "a closed alert loses its mark");
  const newXlsx = { ...alert(3, "critical", "xlsx"), createdAt: "2026-03-05T00:00:00.000Z" };
  assert.deepEqual(pruneHandledAlerts(marks, [xlsx, lodash, newXlsx]).map((kept) => kept.number), [2], "only the package of the new alert loses its marks");
  const olderXlsx = { ...alert(4, "low", "xlsx"), createdAt: "2026-02-01T00:00:00.000Z" };
  assert.deepEqual(pruneHandledAlerts(marks, [xlsx, lodash, olderXlsx]), marks, "an alert emitted before the mark changes nothing");
});

test("unfixablePackages lists the packages without a published fix from the latest audit, except those fixed by hand", () => {
  const audited = operation({
    status: "done",
    steps: { clone: "done", audit: "done", fix: "done", repair: "skipped", push: "skipped" },
    remaining: [
      { project: "", name: "xlsx", severity: "high", fix: "none" },
      { project: "gui", name: "xlsx", severity: "high", fix: "none" },
      { project: "", name: "nth-check", severity: "high", fix: "major" },
      { project: "", name: "abc", severity: "low", fix: "none" },
    ],
  });
  const target = repo("octo/demo", [alert(1, "high", "xlsx")]);
  assert.deepEqual(unfixablePackages(target, [audited]), ["abc", "xlsx"]);
  assert.deepEqual(unfixablePackages({ ...target, handledAlerts: [{ number: 1, package: "xlsx", markedAt: "2026-03-01T10:00:00.000Z" }] }, [audited]), ["abc"]);
  assert.deepEqual(unfixablePackages(target, []), []);
});

test("Store tracks repositories, refuses a duplicate and a second active operation", () => {
  const temp = makeTempDir("tracker-store-");
  try {
    const store = new Store(temp.dir);
    store.addRepo(repo("Octo/Demo"));
    assert.throws(() => store.addRepo(repo("octo/demo")), /already tracked/);
    assert.equal(store.getRepo("OCTO/demo").id, "Octo/Demo");
    store.updateRepo("octo/demo", (current) => ({ ...current, rights: { audit: true, fix: true, push: true } }));
    assert.equal(store.getRepo("Octo/Demo").rights.push, true);

    store.createOperation(operation({ id: "op-a", repoId: "Octo/Demo", status: "running" }));
    assert.throws(() => store.createOperation(operation({ id: "op-b", repoId: "Octo/Demo" })), /already in progress/);
    assert.throws(() => store.removeRepo("Octo/Demo"), /cancel it before removing/);
    store.updateOperation("op-a", (current) => ({ ...current, status: "cancelled" }));
    store.removeRepo("Octo/Demo");
    assert.equal(store.listRepos().length, 0);
    assert.throws(() => store.getOperation("op-a"), /not found/);
    assert.throws(() => store.getOperation("../evil"), /not found/);
  } finally {
    temp.cleanup();
  }
});

test("Store reads a repository saved without a chosen branch as analysing its default branch", () => {
  const temp = makeTempDir("tracker-branch-");
  try {
    const saved = { ...repo("octo/demo"), defaultBranch: "master" } as Partial<Repo>;
    delete saved.branch;
    delete saved.pullRequests;
    fs.writeFileSync(path.join(temp.dir, "repos.json"), JSON.stringify({ repos: [saved] }));
    const store = new Store(temp.dir);
    assert.equal(store.getRepo("octo/demo").branch, "master");
    assert.deepEqual(store.getRepo("octo/demo").pullRequests, []);
  } finally {
    temp.cleanup();
  }
});

test("Store keeps categories unique by name and frees their repositories when deleted", () => {
  const temp = makeTempDir("tracker-categories-");
  try {
    const { createdAt: _createdAt, ...undated } = alert(1, "high", "lodash");
    fs.writeFileSync(path.join(temp.dir, "repos.json"), JSON.stringify({ repos: [{ ...repo("octo/demo", [undated as Alert], "2026-02-01T00:00:00.000Z"), categoryId: undefined }] }));
    const store = new Store(temp.dir);
    assert.equal(store.getRepo("octo/demo").categoryId, null);
    assert.equal(store.getRepo("octo/demo").alerts[0].createdAt, "2026-02-01T00:00:00.000Z");
    assert.deepEqual(store.getRepo("octo/demo").handledAlerts, []);
    assert.deepEqual(store.listCategories(), []);

    const tools = store.createCategory("  Outils ");
    assert.equal(tools.name, "Outils");
    assert.throws(() => store.createCategory("outils"), /already exists/);
    const mcp = store.createCategory("MCP");
    assert.throws(() => store.renameCategory(mcp.id, "OUTILS"), /already exists/);
    assert.equal(store.renameCategory(mcp.id, "mcp").name, "mcp");
    assert.deepEqual(store.listCategories().map((category) => category.name), ["mcp", "Outils"]);

    store.updateRepo("octo/demo", (current) => ({ ...current, categoryId: tools.id }));
    assert.throws(() => store.updateRepo("octo/demo", (current) => ({ ...current, categoryId: "missing" })), /does not exist/);
    assert.throws(() => store.addRepo({ ...repo("octo/other"), categoryId: "missing" }), /does not exist/);
    store.deleteCategory(tools.id);
    assert.equal(store.getRepo("octo/demo").categoryId, null);
    assert.throws(() => store.deleteCategory(tools.id), /does not exist/);
  } finally {
    temp.cleanup();
  }
});

test("Store fails a running operation whose process is gone and deletes its clone", () => {
  const temp = makeTempDir("tracker-orphan-");
  try {
    const store = new Store(temp.dir);
    store.addRepo(repo("octo/demo"));
    const workDir = path.join(temp.dir, "clone");
    fs.mkdirSync(workDir);
    store.createOperation(operation({ id: "op-dead", pid: 999_999_999, workDir, steps: { clone: "done", audit: "running", fix: "pending", repair: "pending", push: "pending" } }));
    const [failed] = store.failOrphanedOperations();
    assert.equal(failed.status, "failed");
    assert.equal(failed.steps.audit, "failed");
    assert.equal(failed.workDir, null);
    assert.match(failed.error ?? "", /Interrupted/);
    assert.equal(fs.existsSync(workDir), false);
  } finally {
    temp.cleanup();
  }
});

test("Store reads an operation saved without the vulnerabilities of its first audit", () => {
  const temp = makeTempDir("tracker-found-");
  try {
    const store = new Store(temp.dir);
    const remaining = [{ project: "", name: "lodash", severity: "high" as const, fix: "available" as const }];
    for (const [id, afterFix] of [["op-audit", null], ["op-fix", 1]] as const) {
      const saved = { ...operation({ id, remaining, counts: { initial: 1, afterFix, afterRepair: null } }) } as Partial<Operation>;
      delete saved.found;
      fs.writeFileSync(path.join(temp.dir, "operations", `${id}.json`), JSON.stringify(saved));
    }
    assert.deepEqual(store.getOperation("op-audit").found, remaining, "without a fix, the remaining ones are those of the audit");
    assert.deepEqual(store.getOperation("op-fix").found, [], "after a fix, they are unknown");
  } finally {
    temp.cleanup();
  }
});

test("Store reads an operation saved without scope as an audit of every dependency, and an alert without scope as of unknown scope", () => {
  const temp = makeTempDir("tracker-scope-");
  try {
    const store = new Store(temp.dir);
    const saved = operation() as Partial<Operation>;
    delete saved.scope;
    fs.writeFileSync(path.join(temp.dir, "operations", "op-1.json"), JSON.stringify(saved));
    assert.equal(store.getOperation("op-1").scope, "all");
    const stored = repo("octo/demo", [alert(1, "high", "lodash")]) as any;
    delete stored.alerts[0].scope;
    fs.writeFileSync(path.join(temp.dir, "repos.json"), JSON.stringify({ categories: [], repos: [stored] }));
    assert.equal(store.getRepo("octo/demo").alerts[0].scope, null);
  } finally {
    temp.cleanup();
  }
});

test("Store reads an operation saved before the repair step as one whose repair was skipped", () => {
  const temp = makeTempDir("tracker-repair-");
  try {
    const store = new Store(temp.dir);
    const saved = operation({ steps: { clone: "done", audit: "done", fix: "done", repair: "skipped", push: "skipped" } }) as any;
    delete saved.steps.repair;
    delete saved.counts.afterRepair;
    delete saved.repair;
    fs.writeFileSync(path.join(temp.dir, "operations", "op-1.json"), JSON.stringify(saved));
    const read = store.getOperation("op-1");
    assert.equal(read.steps.repair, "skipped");
    assert.equal(read.counts.afterRepair, null);
    assert.equal(read.repair, null);
  } finally {
    temp.cleanup();
  }
});

test("Store reads an operation that waited for a decision of the user as cancelled, its fixes by Claude without their sessions", () => {
  const temp = makeTempDir("tracker-waiting-");
  try {
    const store = new Store(temp.dir);
    const saved = operation({ status: "waiting_push" as any }) as any;
    saved.steps = { clone: "done", audit: "done", fix: "done", analysis: "done", force: "skipped", repair: "done", push: "pending" };
    saved.counts = { initial: 2, afterFix: 1, afterForce: null, afterRepair: 0 };
    saved.forceCandidates = [];
    saved.analysis = { startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, turns: 1, activity: [], report: null, task: null, error: null };
    saved.sessions = [{ kind: "analysis" }];
    saved.repair = { runs: 1, startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, turns: 3, activity: [], base: "b", auditCommit: null, commit: null, report: null, task: null, error: null };
    fs.writeFileSync(path.join(temp.dir, "operations", "op-1.json"), JSON.stringify(saved));
    const read = store.getOperation("op-1") as any;
    assert.equal(read.status, "cancelled");
    assert.deepEqual(Object.keys(read.steps), ["clone", "audit", "fix", "repair", "push"]);
    assert.deepEqual(read.counts, { initial: 2, afterFix: 1, afterRepair: 0 });
    assert.deepEqual([read.repair.turns, read.repair.events], [3, []]);
    assert.ok(!("analysis" in read) && !("sessions" in read) && !("forceCandidates" in read) && !("runs" in read.repair));
  } finally {
    temp.cleanup();
  }
});

test("organizerUrl requires an absolute https address, except for a site on this machine", () => {
  assert.equal(organizerUrl("https://organizer.example.com/"), "https://organizer.example.com");
  assert.equal(organizerUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => organizerUrl("http://organizer.example.com"), /must use https/);
  assert.throws(() => organizerUrl("organizer.example.com"), /not an absolute URL/);
  assert.throws(() => organizerUrl("https://user:pw@organizer.example.com"), /credentials/);
});

test("saveSettings tests a changed organizer connection, checks a new Claude token and never returns the tokens", async () => {
  const temp = makeTempDir("tracker-settings-");
  const checked: string[] = [];
  const checks: SettingsChecks = {
    organizer: async (connection) => {
      checked.push(`organizer ${connection.url} ${connection.token}`);
      return { space: { id: "s-1", name: "Maintenance" }, owner: { id: "u-1", name: "Matthieu Pin", email: "m@example.com" } };
    },
    claudeToken: async (token) => {
      checked.push(`claude ${token}`);
      if (token === "bad-token") throw new Error("The Claude token was refused: Invalid bearer token");
    },
  };
  const analysis = { maxTurns: 40, maxMinutes: 15 };
  try {
    assert.deepEqual(readSettings(temp.dir), DEFAULT_SETTINGS);

    const view = await saveSettings(temp.dir, { organizerUrl: "https://organizer.example.com", organizerToken: "org-secret-1234", claudeToken: "sk-ant-oat01-abcd", analysis }, checks);
    assert.deepEqual(checked, ["organizer https://organizer.example.com org-secret-1234", "claude sk-ant-oat01-abcd"]);
    assert.deepEqual(view.organizer, { url: "https://organizer.example.com", tokenHint: "1234", space: "Maintenance", owner: "Matthieu Pin" });
    assert.equal(view.claude.tokenHint, "abcd");
    assert.equal(Date.parse(view.claude.expiresAt!) - Date.parse(view.claude.savedAt!), 365 * 24 * 3600_000);
    assert.equal(view.ready, true);
    assert.ok(!JSON.stringify(view).includes("org-secret") && !JSON.stringify(view).includes("sk-ant"), "the GUI never receives a whole token");

    checked.length = 0;
    const limits = await saveSettings(temp.dir, { organizerUrl: "https://organizer.example.com", analysis: { ...analysis, maxTurns: 60 } }, checks);
    assert.deepEqual(checked, [], "an unchanged connection and no new Claude token need no check");
    assert.equal(limits.analysis.maxTurns, 60);

    await assert.rejects(saveSettings(temp.dir, { organizerUrl: "https://organizer.example.com", claudeToken: "bad-token", analysis }, checks), /Invalid bearer token/);
    assert.equal(readSettings(temp.dir).claude.token, "sk-ant-oat01-abcd", "a refused token saves nothing");
    assert.equal(readSettings(temp.dir).analysis.maxTurns, 60);
  } finally {
    temp.cleanup();
  }
});

test("Store keeps the 20 most recent operations of a repository", () => {
  const temp = makeTempDir("tracker-prune-");
  try {
    const store = new Store(temp.dir);
    store.addRepo(repo("octo/demo"));
    for (let index = 0; index < 23; index += 1) {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      store.createOperation(operation({ id: `op-${String(index).padStart(2, "0")}`, status: "done", createdAt }));
    }
    const operations = store.listOperations("octo/demo");
    assert.equal(operations.length, 20);
    assert.equal(operations[0].id, "op-22");
    assert.equal(operations[19].id, "op-03");
  } finally {
    temp.cleanup();
  }
});

test("staleRepos selects repositories never synced or synced too long ago, deprecated ones aside", () => {
  const temp = makeTempDir("tracker-stale-");
  try {
    const store = new Store(temp.dir);
    const at = Date.parse("2026-01-01T01:00:00.000Z");
    store.addRepo(repo("o/never"));
    store.addRepo(repo("o/old", [], "2026-01-01T00:40:00.000Z"));
    store.addRepo(repo("o/fresh", [], "2026-01-01T00:55:00.000Z"));
    store.addRepo({ ...repo("o/deprecated", [], "2026-01-01T00:10:00.000Z"), deprecatedAt: "2026-01-01T00:20:00.000Z" });
    assert.deepEqual(staleRepos(store, 10 * 60_000, at).map((r) => r.id), ["o/never", "o/old"]);
  } finally {
    temp.cleanup();
  }
});

test("the audit targets every repository, a category or the queue in its order, deprecated ones aside", () => {
  const temp = makeTempDir("tracker-target-");
  try {
    const store = new Store(temp.dir);
    const category = store.createCategory("MCP");
    store.addRepo({ ...repo("o/a"), categoryId: category.id, queuedAt: "2026-01-02T00:00:00.000Z" });
    store.addRepo({ ...repo("o/b"), categoryId: category.id });
    store.addRepo({ ...repo("o/c"), queuedAt: "2026-01-01T00:00:00.000Z" });
    store.addRepo({ ...repo("o/d"), categoryId: category.id, queuedAt: "2026-01-01T12:00:00.000Z", deprecatedAt: "2026-01-03T00:00:00.000Z" });
    const ids = (repos: Repo[]) => repos.map((r) => r.id).sort();
    assert.deepEqual(ids(auditTargetRepos(store, { kind: "all" })), ["o/a", "o/b", "o/c"]);
    assert.deepEqual(ids(auditTargetRepos(store, { kind: "category", categoryId: category.id })), ["o/a", "o/b"]);
    assert.deepEqual(auditTargetRepos(store, { kind: "queue" }).map((r) => r.id), ["o/c", "o/a"]);
    assert.deepEqual(queuedRepos(store).map((r) => r.id), ["o/c", "o/a"]);
    assert.throws(() => auditTargetRepos(store, { kind: "category", categoryId: "missing" }), /does not exist/);
  } finally {
    temp.cleanup();
  }
});

test("describeOperation reports counts, changes and the pull request", () => {
  const text = describeOperation(
    operation({
      status: "done",
      projects: ["", "gui"],
      steps: { clone: "done", audit: "done", fix: "done", repair: "skipped", push: "done" },
      counts: { initial: 4, afterFix: 2, afterRepair: null },
      changes: [{ project: "gui", name: "lodash", from: "4.17.20", to: "4.18.1" }],
      branch: "fix/npm-audit-2026-10-28-143205",
      pullRequest: { number: 7, url: "https://github.com/octo/demo/pull/7" },
    })
  );
  assert.match(text, /^npm audit fix on octo\/demo, production dependencies \(operation op-1\): done\./);
  assert.match(text, /npm projects: \.\/, gui\//);
  assert.match(text, /Vulnerabilities: 4 found, 2 left after npm audit fix/);
  assert.match(text, /Updated packages \(1\): gui\/lodash 4\.17\.20 → 4\.18\.1/);
  assert.match(text, /Pull request #7: https:\/\/github.com\/octo\/demo\/pull\/7 \(branch fix\/npm-audit-2026-10-28-143205\)/);
});

test("setup-mcp writes an entry with the token placeholder and rejects both exposures", () => {
  const temp = makeTempDir("tracker-setup-");
  try {
    assert.deepEqual(parseGuiExposure(["--proxy_url=http://localhost:3000/"]), { exposure: { proxyUrl: "http://localhost:3000" } });
    assert.ok("error" in parseGuiExposure(["--proxy_url=http://x", "--app_port=4000"]));
    assert.ok("error" in parseGuiExposure(["--app_port=99999"]));

    const log = console.log;
    console.log = () => {};
    try {
      assert.equal(runSetupMcp({ cwd: temp.dir, force: false, exposure: { appPort: 4700 } }), 0);
    } finally {
      console.log = log;
    }
    const config = JSON.parse(fs.readFileSync(path.join(temp.dir, ".mcp.json"), "utf-8"));
    const entry = config.mcpServers["mcp-dependabot-tracker"];
    assert.deepEqual(entry.args, ["-y", "@imenam/mcp-dependabot-tracker"]);
    assert.equal(entry.env.GITHUB_TOKEN, "");
    assert.equal(entry.env.CLONE_DIR, "");
    assert.equal(entry.env.APP_PORT, "4700");
    assert.equal(entry.env.PROXY_URL, "");

    const error = console.error;
    console.error = () => {};
    try {
      assert.equal(runSetupMcp({ cwd: temp.dir, force: false }), 1);
    } finally {
      console.error = error;
    }
  } finally {
    temp.cleanup();
  }
});

test("the fixes by Claude check that bubblewrap can build a sandbox on Linux, and only there", async () => {
  await assertSandboxAvailable("win32", "no-such-bwrap");
  await assert.rejects(assertSandboxAvailable("linux", "no-such-bwrap"), /need bubblewrap \(bwrap\).*not in the PATH of the MCP server\. Install it on the server: sudo apt-get install -y bubblewrap socat/);
  await assert.rejects(assertSandboxAvailable("linux", process.execPath), /bubblewrap \(bwrap\) is installed but cannot create a sandbox for the account of the MCP server: .*--ro-bind[\s\S]*apparmor_restrict_unprivileged_userns/);
});

test("operationSummary sums an operation up for the history of its repository", () => {
  const fix = operationSummary(
    operation({
      status: "done",
      counts: { initial: 4, afterFix: 2, afterRepair: 0 },
      repair: { startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, turns: 1, activity: [], events: [], base: "b", auditCommit: null, commit: null, report: null, task: null, error: null },
    })
  );
  assert.deepEqual([fix.before, fix.after, fix.claude], [4, 0, true]);
  const audit = operationSummary(operation({ kind: "audit", status: "done", counts: { initial: 6, afterFix: null, afterRepair: null } }));
  assert.deepEqual([audit.before, audit.after, audit.claude], [6, 6, false]);
  assert.ok(!("log" in fix) && !("repair" in fix), "the history leaves the log and the session of Claude out");
});

test("the npm tools of Claude run fixed npm commands, with names only as arguments", () => {
  assert.deepEqual(npmArgs("npm_install_lockfile", { project: "", packages: ["mermaid@12.0.1"] }, "production"), ["install", "--package-lock-only", "--ignore-scripts", "mermaid@12.0.1"]);
  assert.deepEqual(npmArgs("npm_audit", { project: "web" }, "production"), ["audit", "--omit=dev"]);
  assert.deepEqual(npmArgs("npm_audit", { project: "web" }, "all"), ["audit"]);
  assert.deepEqual(npmArgs("npm_run", { project: "", script: "test:unit" }, "all"), ["run", "test:unit"]);
  assert.deepEqual(npmArgs("tsc", { project: "" }, "all"), ["exec", "--no", "--", "tsc", "--noEmit"]);
  assert.throws(() => npmArgs("npm_install_lockfile", { project: "", packages: ["--global"] }, "all"), /package or script name/);
  assert.throws(() => npmArgs("npm_run", { project: "", script: "test; rm -rf /" }, "all"), /package or script name/);
  assert.throws(() => npmArgs("npm_ci", { project: "", force: true }, "all"), /force/);
});

test("the npm tools of Claude only run in a project folder of the clone", () => {
  const temp = makeTempDir("npm-tools-");
  try {
    const root = path.join(temp.dir, "repo");
    fs.mkdirSync(path.join(root, "web", "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(path.join(root, "web", "package.json"), "{}");
    fs.writeFileSync(path.join(root, "web", "node_modules", "x", "package.json"), "{}");
    const sandbox = { root, cache: path.join(temp.dir, "npm-cache") };
    assert.equal(projectDir(sandbox, ""), root);
    assert.equal(projectDir(sandbox, "web"), path.join(root, "web"));
    assert.throws(() => projectDir(sandbox, ".."), /not a project folder/);
    assert.throws(() => projectDir(sandbox, "web/node_modules/x"), /not a project folder/);
    assert.throws(() => projectDir(sandbox, "src"), /has no package.json/);

    const args = bwrapArgs(sandbox, path.join(root, "web"), ["ci"]);
    const pairs = (flag: string) => args.flatMap((arg, index) => (arg === flag ? [[args[index + 1], args[index + 2]]] : []));
    assert.deepEqual(pairs("--bind"), [[root, root], [sandbox.cache, sandbox.cache]], "only the clone and the npm cache are writable");
    assert.ok(!pairs("--ro-bind").some(([source]) => source === "/" || source === temp.dir), "the rest of the server stays hidden");
    assert.ok(args.includes("--clearenv"));
    assert.deepEqual(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2), ["--chdir", path.join(root, "web")]);
    assert.deepEqual(args.slice(-2), ["npm", "ci"]);
  } finally {
    temp.cleanup();
  }
});
