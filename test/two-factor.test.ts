import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";

import { TEST_AUTH_SECRET, TEST_VAULT_KEY, TrackerServer, baseEnv, cookiesOf, freePort, makeTempDir, runUserCommand, signIn, totpCode, waitFor } from "./helpers.js";

/**
 * Double authentification de bout en bout, sur un serveur propre à ce fichier :
 * activation par `user totp`, connexion en deux étapes par l'API de Better Auth.
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
    MCP_DATA_DIR: path.join(temp.dir, "data"),
    CLONE_DIR: path.join(temp.dir, "clones"),
    GITHUB_TOKEN: "t",
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

test("an account with two-factor authentication signs in with its password, then a TOTP code or a backup code", async () => {
  const user = { email: "totp@example.com", password: "a password with a second factor" };
  assert.equal((await runUserCommand(serverEnv, ["add", user.email], `${user.password}\n`)).code, 0);
  const before = await signIn(baseUrl, user);
  const withCookie = (cookie: string) => fetch(`${baseUrl}/api/repos`, { headers: { Cookie: cookie } }).then((r) => r.status);
  assert.equal(await withCookie(before), 200);

  const enabled = await runUserCommand(serverEnv, ["totp", user.email]);
  assert.equal(enabled.code, 0, enabled.stderr);
  const key = /authentification : ([A-Z2-7]+)/.exec(enabled.stdout)?.[1] ?? "";
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
