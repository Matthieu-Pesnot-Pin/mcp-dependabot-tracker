import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";

import { terminalQrCode } from "../src/cli/users.js";
import { TEST_AUTH_SECRET, TEST_VAULT_KEY, TrackerServer, baseEnv, cookiesOf, freePort, makeTempDir, runUserCommand, signIn, totpCode, waitFor } from "./helpers.js";

/**
 * Double authentification de bout en bout, sur un serveur propre à ce fichier,
 * lancé sans token GitHub : activation par `user totp`, connexion en deux
 * étapes par l'API de Better Auth. Le serveur démarre et renvoie aux réglages
 * pour le token GitHub.
 */

let temp: { dir: string; cleanup: () => void };
let server: TrackerServer;
let baseUrl: string;
let serverEnv: Record<string, string | undefined>;

before(async () => {
  temp = makeTempDir("tracker-two-factor-");
  const port = await freePort();
  baseUrl = `http://localhost:${port}`;
  serverEnv = {
    ...baseEnv(),
    DATA_DIR: path.join(temp.dir, "data"),
    APP_PORT: String(port),
    APP_URL: baseUrl,
    AUTH_SECRET: TEST_AUTH_SECRET,
    VAULT_KEY: TEST_VAULT_KEY,
  };
  server = new TrackerServer(serverEnv);
  await waitFor("the server", () => fetch(`${baseUrl}/health`).then((r) => r.ok, () => false), (ok) => ok, 20_000);
});

after(async () => {
  await server?.stop();
  temp?.cleanup();
});

test("without a GitHub token, the server starts, says so, and refuses what needs GitHub until the token is set", async () => {
  assert.match(server.stderr.join(""), /The GitHub token of the tracker is not set: enter it in the settings of the interface/);
  const plain = { email: "plain@example.com", password: "a plain long password" };
  assert.equal((await runUserCommand(serverEnv, ["add", plain.email], `${plain.password}\n`)).code, 0);
  const cookie = await signIn(baseUrl, plain);
  const get = (route: string) => fetch(`${baseUrl}/api/${route}`, { headers: { Cookie: cookie } });
  assert.equal((await (await get("settings")).json()).github.tokenHint, null);
  assert.equal((await get("repos")).status, 200, "the interface works without the token");
  const sync = await fetch(`${baseUrl}/api/sync`, { method: "POST", headers: { Cookie: cookie, Origin: baseUrl } });
  assert.equal(sync.status, 400);
  assert.match((await sync.json()).error, /GitHub token of the tracker is not set: enter it in the settings \(Réglages › GitHub\)/);
  assert.equal((await runUserCommand(serverEnv, ["remove", plain.email])).code, 0);
});

test("an account with two-factor authentication signs in with its password, then a TOTP code or a backup code", async () => {
  const user = { email: "totp@example.com", password: "a password with a second factor" };
  assert.equal((await runUserCommand(serverEnv, ["add", user.email], `${user.password}\n`)).code, 0);
  const before = await signIn(baseUrl, user);
  const withCookie = (cookie: string) => fetch(`${baseUrl}/api/repos`, { headers: { Cookie: cookie } }).then((r) => r.status);
  assert.equal(await withCookie(before), 200);

  const enabled = await runUserCommand(serverEnv, ["totp", user.email]);
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.ok(!enabled.stdout.includes("QR code") && !enabled.stdout.includes("\u001b["), "outside a terminal, the output holds no QR code nor escape sequence");
  const key =/authentification : ([A-Z2-7]+)/.exec(enabled.stdout)?.[1] ?? "";
  assert.ok(enabled.stdout.includes(`otpauth://totp/Dependabot%20Tracker:${encodeURIComponent(user.email)}?secret=${key}&issuer=Dependabot+Tracker&digits=6&period=30`), enabled.stdout);
  const backupCodes = enabled.stdout.match(/^  \S{5}-\S{5}$/gm)?.map((line) => line.trim()) ?? [];
  assert.equal(backupCodes.length, 10);
  assert.equal(await withCookie(before), 401, "enabling two-factor authentication closes the sessions opened by the password alone");
  assert.match((await runUserCommand(serverEnv, ["list"])).stdout, /totp@example\.com\t.*\t2FA\n/);

  const post = (route: string, body: unknown, cookie = "") =>
    fetch(`${baseUrl}/api/auth/${route}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl, Cookie: cookie }, body: JSON.stringify(body) });
  /** Première étape : le mot de passe ; rend le cookie du défi de double authentification. */
  const challenge = async () => {
    const response = await post("sign-in/email", user);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).twoFactorRedirect, true);
    const pending = cookiesOf(response);
    assert.equal(await withCookie(pending), 401, "the password alone opens no session");
    return pending;
  };

  const pending = await challenge();
  const wrong = await post("two-factor/verify-totp", { code: totpCode(key, Date.now() + 3_600_000) }, pending);
  assert.deepEqual([wrong.status, (await wrong.json()).code], [401, "INVALID_CODE"]);
  const verified = await post("two-factor/verify-totp", { code: totpCode(key) }, pending);
  assert.equal(verified.status, 200, await verified.clone().text());
  assert.equal((await verified.json()).user.email, user.email);
  assert.equal(await withCookie(cookiesOf(verified)), 200);

  const second = await challenge();
  const byBackupCode = await post("two-factor/verify-backup-code", { code: backupCodes[0] }, second);
  assert.equal(byBackupCode.status, 200);
  assert.equal(await withCookie(cookiesOf(byBackupCode)), 200);
  const reused = await post("two-factor/verify-backup-code", { code: backupCodes[0] }, await challenge());
  assert.equal(reused.status, 401, "a backup code works once");

  assert.equal((await runUserCommand(serverEnv, ["totp", user.email, "--remove"])).code, 0);
  assert.match((await runUserCommand(serverEnv, ["list"])).stdout, /totp@example\.com\t.*\tsans 2FA\n/);
});

test("the QR code of the key is drawn with block characters, one line per two rows of modules", async () => {
  const uri = "otpauth://totp/Dependabot%20Tracker:a%40example.com?secret=GEZDGNBVGY3TQOJQ&issuer=Dependabot+Tracker&digits=6&period=30";
  const lines = (await terminalQrCode(uri))
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((line) => line.trim() !== "");
  assert.ok(lines.length >= 15, `${lines.length} lines`);
  assert.ok(lines.every((line) => /[▀▄█ ]/.test(line)));
  assert.notEqual(await terminalQrCode(uri), await terminalQrCode(uri.replace("GEZDGNBVGY3TQOJQ", "MFRGGZDFMZTWQ2LK")), "the code depends on the key");
});
