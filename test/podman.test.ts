import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PODMAN, assertContainersAvailable, pullImage, runInContainer } from "../src/core/containers.js";
import { NODE_IMAGE, npm } from "../src/core/managers/npm.js";
import { runManager, type ManagerContext } from "../src/core/managers/types.js";
import { pnpm } from "../src/core/managers/pnpm.js";
import { composer } from "../src/core/managers/composer.js";
import { buildImage } from "../src/core/containers.js";
import { VULNERABLE_COMPOSER_FIXTURE, VULNERABLE_FIXTURE, VULNERABLE_PNPM_FIXTURE, makeTempDir, npmRegistryReachable } from "./helpers.js";

/**
 * Conteneurs réels : vrai Podman rootless, vraie image de Node.js, vrai
 * registre npm. Ces tests ne tournent que sous Linux, quand `podman` est
 * installé.
 */

const podmanInstalled = process.platform === "linux" && spawnSync("podman", ["--version"]).status === 0;
const skip = !podmanInstalled ? "Podman is not installed on this Linux machine" : !(await npmRegistryReachable()) ? "the npm registry is unreachable" : false;

/** Clone factice : le projet npm vulnérable des fixtures, et son cache à côté. */
function workspaceFrom(dir: string) {
  const root = path.join(dir, "repo");
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(path.join(VULNERABLE_FIXTURE, "package.fixture.json"), path.join(root, "package.json"));
  fs.copyFileSync(path.join(VULNERABLE_FIXTURE, "package-lock.fixture.json"), path.join(root, "package-lock.json"));
  return { root, cache: path.join(dir, "cache") };
}

test("npm runs in a rootless container that writes the clone under the account of the server", { skip, timeout: 600_000 }, async () => {
  const temp = makeTempDir("podman-real-");
  try {
    const workspace = workspaceFrom(temp.dir);
    await assertContainersAvailable(PODMAN, temp.dir);
    await pullImage(PODMAN, NODE_IMAGE, temp.dir);

    const ctx: ManagerContext = { runtime: PODMAN, workspace, scope: "all", log: () => {} };
    const audit = await runManager(npm, ctx, "", ["audit", "--json"]);
    assert.equal(JSON.parse(audit.stdout).auditReportVersion, 2, audit.stderr);

    const before = fs.readFileSync(path.join(workspace.root, "package-lock.json"), "utf-8");
    const fix = await runManager(npm, ctx, "", ["audit", "fix", "--package-lock-only", "--ignore-scripts"]);
    assert.equal(fix.code, 0, fix.stderr);
    const lockfile = path.join(workspace.root, "package-lock.json");
    assert.notEqual(fs.readFileSync(lockfile, "utf-8"), before, "npm audit fix updated the lockfile of the clone");
    assert.equal(fs.statSync(lockfile).uid, process.getuid!(), "the lockfile still belongs to the account of the server");
    assert.ok(fs.readdirSync(path.join(workspace.cache, "npm")).length > 0, "npm used the cache of the operation");
  } finally {
    temp.cleanup();
  }
});

test("a container sees neither the server's files nor its variables", { skip, timeout: 600_000 }, async () => {
  const temp = makeTempDir("podman-isolation-");
  process.env.HTTP_PROXY_TEST_SECRET = "must-not-leak";
  try {
    const workspace = workspaceFrom(temp.dir);
    await pullImage(PODMAN, NODE_IMAGE, temp.dir);
    const script = [
      "const fs = require('fs');",
      "const out = { env: Object.keys(process.env), home: fs.existsSync(process.argv[1]), uid: process.getuid() };",
      "try { fs.writeFileSync('/usr/x', 'x'); out.writableRoot = true; } catch { out.writableRoot = false; }",
      "console.log(JSON.stringify(out));",
    ].join(" ");
    const result = await runInContainer(PODMAN, workspace, { image: NODE_IMAGE, cwd: "", command: ["node", "-e", script, temp.dir] });
    assert.equal(result.code, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.equal(seen.home, false, "the folders of the server are not mounted");
    assert.equal(seen.writableRoot, false, "the file system of the container is read-only");
    assert.equal(seen.uid, process.getuid!(), "the container runs under the account of the server");
    assert.ok(!seen.env.includes("HTTP_PROXY_TEST_SECRET"));
  } finally {
    delete process.env.HTTP_PROXY_TEST_SECRET;
    temp.cleanup();
  }
});

test("pnpm 11 audits and fixes a workspace in a container", { skip, timeout: 600_000 }, async () => {
  const temp = makeTempDir("podman-pnpm-");
  try {
    const root = path.join(temp.dir, "repo");
    fs.cpSync(VULNERABLE_PNPM_FIXTURE, root, { recursive: true });
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.includes(".fixture.")) fs.renameSync(path.join(entry.parentPath, entry.name), path.join(entry.parentPath, entry.name.replace(".fixture.", ".")));
    }
    const ctx: ManagerContext = { runtime: PODMAN, workspace: { root, cache: path.join(temp.dir, "cache") }, scope: "production", log: () => {} };
    await pullImage(PODMAN, NODE_IMAGE, temp.dir);
    const before = await pnpm.audit(ctx, "");
    assert.deepEqual(before.vulnerabilities.map((v) => v.name), ["lodash", "nth-check"]);
    await pnpm.fix(ctx, "", before.vulnerabilities);
    assert.deepEqual((await pnpm.audit(ctx, "")).vulnerabilities.map((v) => v.name), ["nth-check"]);
    assert.ok(!fs.existsSync(path.join(root, "node_modules")), "the automatic fixes install nothing");
  } finally {
    temp.cleanup();
  }
});

test("Composer audits and fixes a project in the image built for its PHP version", { skip, timeout: 900_000 }, async () => {
  const temp = makeTempDir("podman-composer-");
  try {
    const root = path.join(temp.dir, "repo");
    fs.mkdirSync(root, { recursive: true });
    fs.copyFileSync(path.join(VULNERABLE_COMPOSER_FIXTURE, "composer.fixture.json"), path.join(root, "composer.json"));
    fs.copyFileSync(path.join(VULNERABLE_COMPOSER_FIXTURE, "composer.fixture.lock"), path.join(root, "composer.lock"));
    const ctx: ManagerContext = { runtime: PODMAN, workspace: { root, cache: path.join(temp.dir, "cache") }, scope: "production", log: () => {} };
    const image = composer.image(ctx, "");
    await buildImage(PODMAN, image.name, image.containerfile!, temp.dir);
    const before = await composer.audit(ctx, "");
    assert.deepEqual(before.vulnerabilities.map((v) => v.name), ["guzzlehttp/psr7", "phpmailer/phpmailer"]);
    await composer.fix(ctx, "", before.vulnerabilities);
    assert.deepEqual((await composer.audit(ctx, "")).vulnerabilities.map((v) => v.name), ["phpmailer/phpmailer"]);
    assert.ok(!fs.existsSync(path.join(root, "vendor")), "the automatic fixes install nothing");
    assert.equal(fs.statSync(path.join(root, "composer.lock")).uid, process.getuid!());
  } finally {
    temp.cleanup();
  }
});
