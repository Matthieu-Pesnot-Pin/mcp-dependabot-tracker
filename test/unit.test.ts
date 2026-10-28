import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseRepoRef } from "../src/core/repo-ref.js";
import { nextPageUrl } from "../src/core/github.js";
import { diffLockfiles, forceCandidates, parseAuditReport, parseLockfile, parseNpmJson } from "../src/core/npm-audit.js";
import { branchName, isTrackerBranch } from "../src/core/operations.js";
import { runCommand } from "../src/core/commands.js";
import { MAX_SUGGESTIONS, searchRepositories } from "../shared/repo-search.js";
import { cleanAuditAt, pruneHandledAlerts, sortAlerts, sortRepos, staleRepos, trackerPullRequests, unfixablePackages } from "../src/core/repos.js";
import { Store } from "../src/core/store.js";
import { parseGuiExposure, runSetupMcp } from "../src/cli/setup-mcp.js";
import { describeOperation } from "../src/tools/format.js";
import { DEFAULT_RIGHTS, type Alert, type Operation, type Repo } from "../shared/schemas/model.schema.js";
import { makeTempDir } from "./helpers.js";

function alert(number: number, severity: Alert["severity"], pkg: string): Alert {
  return { number, severity, ecosystem: "npm", package: pkg, manifestPath: "package-lock.json", summary: "s", url: "u", patchedVersion: null, createdAt: "2026-01-01T00:00:00.000Z" };
}

function repo(id: string, alerts: Alert[] = [], syncedAt: string | null = null): Repo {
  const [owner, name] = id.split("/");
  return { id, owner, name, defaultBranch: "main", branch: "main", categoryId: null, addedAt: "2026-01-01T00:00:00.000Z", rights: DEFAULT_RIGHTS, alerts, handledAlerts: [], pullRequests: [], syncedAt, syncError: null };
}

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-1",
    repoId: "octo/demo",
    kind: "fix",
    origin: "user",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pid: process.pid,
    workDir: null,
    baseBranch: "main",
    cancelRequested: false,
    steps: { clone: "pending", audit: "pending", fix: "pending", force: "pending", push: "pending" },
    projects: [],
    counts: { initial: null, afterFix: null, afterForce: null },
    remaining: [],
    forceCandidates: [],
    changes: [],
    commitMessage: "fix",
    branch: null,
    pullRequest: null,
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
    vulnerabilities.map((v) => [v.project, v.name, v.severity, v.fix, v.fixPackage]),
    [
      ["gui", "lodash", "high", "available", null],
      ["gui", "nth-check", "high", "major", "nth-check"],
      ["gui", "css-select", "moderate", "major", "nth-check"],
      ["gui", "request", "moderate", "none", null],
      ["gui", "dompurify", "low", "available", "mermaid"],
    ]
  );
  assert.throws(() => parseAuditReport({ auditVersion: 1 }, ""), /auditReportVersion 2/);
});

test("forceCandidates groups the major upgrades per package and reads the installed version", () => {
  const lock = { packages: { "node_modules/nth-check": { version: "1.0.2" } } };
  assert.deepEqual(forceCandidates(parseAuditReport(REPORT, "gui"), { gui: lock }), [
    { project: "gui", name: "nth-check", from: "1.0.2", to: "3.0.1", vulnerabilities: 2 },
  ]);
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

test("cleanAuditAt reports an audit without vulnerability on the default branch, newer than every alert", () => {
  const alerted = repo("octo/demo", [alert(1, "high", "lodash")]);
  const clean = (overrides: Partial<Operation> = {}) =>
    operation({ status: "done", createdAt: "2026-03-01T10:00:00.000Z", steps: { clone: "done", audit: "done", fix: "skipped", force: "skipped", push: "skipped" }, counts: { initial: 0, afterFix: null, afterForce: null }, ...overrides });

  assert.equal(cleanAuditAt(alerted, [clean()]), "2026-03-01T10:00:00.000Z");
  assert.equal(cleanAuditAt(repo("octo/demo"), [clean()]), null, "no alert, nothing to explain");
  assert.equal(cleanAuditAt(alerted, [clean({ counts: { initial: 2, afterFix: 0, afterForce: null } })]), null, "the audit found vulnerabilities");
  assert.equal(cleanAuditAt(alerted, [clean({ baseBranch: "develop" })]), null, "Dependabot only covers the default branch");
  const newer = repo("octo/demo", [alert(1, "high", "lodash"), { ...alert(2, "critical", "tar"), createdAt: "2026-03-02T08:00:00.000Z" }]);
  assert.equal(cleanAuditAt(newer, [clean()]), null, "an alert emitted after the audit");
  const running = operation({ id: "op-2", createdAt: "2026-03-03T10:00:00.000Z", steps: { clone: "running", audit: "pending", fix: "pending", force: "pending", push: "pending" } });
  assert.equal(cleanAuditAt(alerted, [running, clean()]), "2026-03-01T10:00:00.000Z", "an operation still auditing does not count");
  const dirty = clean({ id: "op-3", createdAt: "2026-03-04T10:00:00.000Z", counts: { initial: 1, afterFix: 1, afterForce: null } });
  assert.equal(cleanAuditAt(alerted, [dirty, clean()]), null, "the latest audit decides");
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
    steps: { clone: "done", audit: "done", fix: "done", force: "skipped", push: "skipped" },
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
    store.updateRepo("octo/demo", (current) => ({ ...current, rights: { audit: true, fix: true, force: false, push: true } }));
    assert.equal(store.getRepo("Octo/Demo").rights.push, true);

    store.createOperation(operation({ id: "op-a", repoId: "Octo/Demo", status: "waiting_push" }));
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
    store.createOperation(operation({ id: "op-dead", pid: 999_999_999, workDir, steps: { clone: "done", audit: "running", fix: "pending", force: "pending", push: "pending" } }));
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

test("staleRepos selects repositories never synced or synced too long ago", () => {
  const temp = makeTempDir("tracker-stale-");
  try {
    const store = new Store(temp.dir);
    const at = Date.parse("2026-01-01T01:00:00.000Z");
    store.addRepo(repo("o/never"));
    store.addRepo(repo("o/old", [], "2026-01-01T00:40:00.000Z"));
    store.addRepo(repo("o/fresh", [], "2026-01-01T00:55:00.000Z"));
    assert.deepEqual(staleRepos(store, 10 * 60_000, at).map((r) => r.id), ["o/never", "o/old"]);
  } finally {
    temp.cleanup();
  }
});

test("describeOperation reports counts, upgrades, changes and the pull request", () => {
  const text = describeOperation(
    operation({
      status: "done",
      projects: ["", "gui"],
      steps: { clone: "done", audit: "done", fix: "done", force: "done", push: "done" },
      counts: { initial: 4, afterFix: 2, afterForce: 0 },
      changes: [{ project: "gui", name: "lodash", from: "4.17.20", to: "4.18.1" }],
      branch: "fix/npm-audit-2026-10-28-143205",
      pullRequest: { number: 7, url: "https://github.com/octo/demo/pull/7" },
    })
  );
  assert.match(text, /^npm audit fix on octo\/demo \(operation op-1\): done\./);
  assert.match(text, /npm projects: \.\/, gui\//);
  assert.match(text, /Vulnerabilities: 4 found, 2 left after npm audit fix, 0 left after npm audit fix --force/);
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
