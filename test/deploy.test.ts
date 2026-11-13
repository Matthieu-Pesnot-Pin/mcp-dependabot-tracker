import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

import { FakeSshServer } from "./fake-ssh.js";
import { FakeGitHub, SERVER_ENTRY, TEST_VAULT_KEY, TrackerServer, baseEnv, fakeCommit, freePort, makeTempDir, waitFor } from "./helpers.js";

/**
 * Déploiement d'un dépôt de bout en bout : serveur réel lancé par `serve`,
 * fausse API GitHub et faux serveur SSH qui exécute les scripts avec bash.
 * Connexion d'un serveur, test et limite d'adresse de la clé, script, puis
 * déploiements réussi, en échec et interrompu.
 */

let server: TrackerServer;
let github: FakeGitHub;
let ssh: FakeSshServer;
let temp: { dir: string; cleanup: () => void };
let baseUrl = "";
let dataDir = "";

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}/api/${route}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

/** Lance un déploiement de octo/app et attend sa fin. */
async function deploy(): Promise<any> {
  const started = await call("POST", "repos/octo/app/deployments");
  assert.equal(started.status, 200, started.json.error);
  return waitFor("the deployment", async () => (await call("GET", `deployments/${started.json.deployment.id}`)).json.deployment, (d) => d.status !== "running", 60_000);
}

before(async () => {
  temp = makeTempDir("tracker-deploy-");
  dataDir = path.join(temp.dir, "data");
  github = new FakeGitHub();
  await github.start();
  github.addRepo("octo", "app", "main", []);
  ssh = new FakeSshServer(path.join(temp.dir, "home"));
  await ssh.start();

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = new TrackerServer({
    ...baseEnv(),
    MCP_DATA_DIR: dataDir,
    CLONE_DIR: path.join(temp.dir, "clones"),
    GITHUB_TOKEN: github.token,
    GITHUB_API_URL: github.url,
    APP_PORT: String(port),
    VAULT_KEY: TEST_VAULT_KEY,
  });
  await waitFor("the server", () => fetch(`${baseUrl}/proxy/health`).then((r) => r.ok, () => false), (ok) => ok, 20_000);
  const added = await call("POST", "repos", { repository: "octo/app", categoryId: null });
  assert.equal(added.status, 200, added.json.error);
});

after(async () => {
  await server?.stop();
  await ssh?.stop();
  await github?.stop();
  temp?.cleanup();
});

let serverId = "";

test("a new server gets its own key pair, kept encrypted on disk, and an installation command for its dedicated key file", async () => {
  const invalid = await call("POST", "deploy-servers", { name: "x", host: "bad host", port: 22, username: "deploy" });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /Hôte invalide/);

  const created = await call("POST", "deploy-servers", { name: "Préprod 2", host: "127.0.0.1", port: ssh.port, username: "deploy" });
  assert.equal(created.status, 200, created.json.error);
  const { server: srv, installCommand } = created.json;
  serverId = srv.id;
  assert.equal(srv.id, "preprod-2");
  assert.match(srv.publicKey, /^ssh-ed25519 \S+ dependabot-tracker@preprod-2$/);
  assert.equal(srv.testedAt, null);
  assert.ok(installCommand.includes(`'restrict ${srv.publicKey}' > ~/.ssh/authorized_keys.d/dependabot-tracker`), installCommand);
  assert.ok(installCommand.includes("/etc/ssh/sshd_config.d/10-dependabot-tracker.conf"), installCommand);
  assert.equal(created.json.privateKeyEncrypted, undefined);

  const stored = fs.readFileSync(path.join(dataDir, "deploy-servers.json"), "utf-8");
  assert.match(stored, /"privateKeyEncrypted": "v1:/);
  assert.doesNotMatch(stored, /PRIVATE KEY/);
});

test("the connection test fails until the key is installed, then records the host key and limits the key to the tracker's address", async () => {
  const refused = await call("POST", `deploy-servers/${serverId}/test`);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /Authentification refusée/);

  const { json } = await call("GET", "deploy-servers");
  const other = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOfAnotherTrackerServer0000000000 other@host";
  ssh.install(`restrict ${other}\nrestrict ${json.servers[0].server.publicKey}`);
  const tested = await call("POST", `deploy-servers/${serverId}/test`);
  assert.equal(tested.status, 200, tested.json.error);
  assert.match(tested.json.fingerprint, /^SHA256:/);
  assert.deepEqual(tested.json.keyFile, { inDedicatedFile: true, inAuthorizedKeys: false, allowedFrom: "127.0.0.1", restrictError: null });
  assert.equal(tested.json.server.server.hostKeyFingerprint, tested.json.fingerprint);
  assert.ok(tested.json.server.server.testedAt);
  const lines = fs.readFileSync(ssh.keyFile, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.equal(lines[0], `restrict ${other}`);
  assert.match(lines[1], /^restrict,from="127\.0\.0\.1" ssh-ed25519 /);

  const again = await call("POST", `deploy-servers/${serverId}/test`);
  assert.equal(again.status, 200, again.json.error);
  assert.equal(again.json.keyFile.allowedFrom, "127.0.0.1");
});

test("a repository deploys only once it has a server and a script", async () => {
  const empty = await call("GET", "repos/octo/app/deploy");
  assert.deepEqual([empty.json.server, empty.json.script, empty.json.deployments], [null, "", []]);
  assert.equal((await call("POST", "repos/octo/app/deployments")).status, 409);

  const unknown = await call("PUT", "repos/octo/app/deploy/server", { serverId: "nope" });
  assert.equal(unknown.status, 404);
  const attached = await call("PUT", "repos/octo/app/deploy/server", { serverId });
  assert.equal(attached.json.server.server.id, serverId);
  const noScript = await call("POST", "repos/octo/app/deployments");
  assert.equal(noScript.status, 409);
  assert.match(noScript.json.error, /no deployment script/);
});

test("a successful deployment runs the script with its variables, follows its lines and clears the « to deploy » mark", async () => {
  const script = ["#!/usr/bin/env bash", "set -euo pipefail", 'echo "branch=$BRANCH repo=$REPO commit=$COMMIT"', "echo 'to stderr' >&2", "echo done"].join("\r\n");
  const saved = await call("PUT", "repos/octo/app/deploy/script", { script });
  assert.equal(saved.json.script, script.replace(/\r\n/g, "\n"));
  assert.equal((await call("PUT", "repos/octo/app/deploy-pending")).status, 200);

  const deployment = await deploy();
  assert.equal(deployment.status, "done", deployment.error ?? deployment.output);
  assert.equal(deployment.exitCode, 0);
  assert.equal(deployment.currentLine, 5);
  assert.equal(deployment.commit, fakeCommit("octo/app", "main"));
  assert.equal(deployment.output, `branch=main repo=octo/app commit=${fakeCommit("octo/app", "main")}\nto stderr\ndone\n`);
  assert.equal((await call("GET", "repos/octo/app")).json.repo.deployPendingAt, null);
});

test("a failing script stops at its failing line, with its exit code", async () => {
  await call("PUT", "repos/octo/app/deploy/script", { script: "set -e\necho before\n(exit 3)\necho after\n" });
  const deployment = await deploy();
  assert.equal(deployment.status, "failed");
  assert.equal(deployment.exitCode, 3);
  assert.equal(deployment.currentLine, 3);
  assert.match(deployment.error, /code 3, à la ligne 3/);
  assert.equal(deployment.output, "before\n");
});

test("a running deployment can be interrupted, and only one runs at a time", async () => {
  await call("PUT", "repos/octo/app/deploy/script", { script: "echo start\nsleep 30\necho never\n" });
  const started = await call("POST", "repos/octo/app/deployments");
  assert.equal(started.status, 200, started.json.error);
  const id = started.json.deployment.id;
  await waitFor("line 2", async () => (await call("GET", `deployments/${id}`)).json.deployment, (d) => d.currentLine === 2, 20_000);
  assert.equal((await call("POST", "repos/octo/app/deployments")).status, 409);
  assert.equal((await call("DELETE", "repos/octo/app")).status, 409);

  const cancelled = await call("POST", `deployments/${id}/cancel`);
  assert.equal(cancelled.status, 200, cancelled.json.error);
  const done = await waitFor("the interruption", async () => (await call("GET", `deployments/${id}`)).json.deployment, (d) => d.status !== "running", 20_000);
  assert.equal(done.status, "cancelled");
  assert.equal(done.output, "start\n");
  assert.equal((await call("POST", `deployments/${id}/cancel`)).status, 409);

  const listed = await call("GET", "repos/octo/app/deploy");
  assert.deepEqual(
    listed.json.deployments.map((d: any) => d.status),
    ["cancelled", "failed", "done"]
  );
  assert.equal(listed.json.deployments[0].output, undefined);
});

test("changing the host forgets the host key and the test; the server refuses to start with another VAULT_KEY", async () => {
  const moved = await call("PUT", `deploy-servers/${serverId}`, { name: "Préprod 2", host: "localhost", port: ssh.port, username: "deploy" });
  assert.equal(moved.status, 200, moved.json.error);
  assert.deepEqual([moved.json.server.hostKeyFingerprint, moved.json.server.testedAt], [null, null]);
  assert.equal((await call("POST", "repos/octo/app/deployments")).status, 409);

  const child = spawn(process.execPath, [SERVER_ENTRY, "serve"], {
    env: { ...baseEnv(), MCP_DATA_DIR: dataDir, CLONE_DIR: path.join(temp.dir, "clones"), GITHUB_TOKEN: "t", APP_PORT: "1", VAULT_KEY: Buffer.alloc(32, 9).toString("base64") },
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.deepEqual([code, /VAULT_KEY does not decrypt the private key of the deployment server "Préprod 2"/.test(stderr)], [1, true], stderr);
});

test("--generate-vault-key prints a key the server accepts", async () => {
  const child = spawn(process.execPath, [SERVER_ENTRY, "--generate-vault-key"]);
  let stdout = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
  assert.equal(Buffer.from(stdout.trim(), "base64").length, 32);
});
