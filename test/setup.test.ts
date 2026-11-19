import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import dotenv from "dotenv";

import { runSetup, type CommandOutcome, type SetupHost } from "../src/cli/setup.js";
import { closeAuth, createAuth, listUsers, migrateAuth } from "../src/core/auth.js";
import { readServerConfig } from "../src/core/server-config.js";
import { mergeEnvFile, nextFreeSubIdRange, renderSystemdUnit, subIdRangesOf } from "../src/core/setup-files.js";
import { makeTempDir } from "./helpers.js";

/**
 * Commande `setup` sur une machine simulée : les commandes système sont
 * notées et jouées par un faux hôte, les fichiers système vivent sous une
 * racine temporaire, le compte de l'interface est créé pour de vrai.
 */

const UID = 984;
const PASSWORD = "un-mot-de-passe-solide";

interface FakeMachine {
  host: SetupHost;
  calls: string[][];
  root: string;
  packageRoot: string;
  home: string;
}

function fakeMachine(dir: string, options: { userExists?: boolean; installed?: string[] } = {}): FakeMachine {
  const root = path.join(dir, "root");
  const packageRoot = path.join(dir, "package");
  const home = path.join(dir, "home", "dependabot-tracker");
  fs.mkdirSync(path.join(root, "etc"), { recursive: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(root, "etc", "subuid"), "ubuntu:100000:65536\nweb:165536:65536\n");
  fs.writeFileSync(path.join(root, "etc", "subgid"), "ubuntu:100000:65536\nweb:165536:65536\nother:300000:65536\n");
  let userExists = options.userExists ?? false;
  const installed = new Set(options.installed ?? ["git", "podman", "uidmap", "passt", "slirp4netns", "catatonit", "bubblewrap", "nginx"]);
  const calls: string[][] = [];
  const ok = (stdout = ""): CommandOutcome => ({ code: 0, stdout, stderr: "" });
  const host: SetupHost = {
    platform: "linux",
    isRoot: true,
    interactive: false,
    root,
    packageRoot,
    nodePath: "/usr/bin/node",
    run: (command, args) => {
      calls.push([command, ...args]);
      if (command === "getent") return userExists ? ok(`dependabot-tracker:x:${UID}:979::${home}:/usr/sbin/nologin\n`) : { code: 2, stdout: "", stderr: "" };
      if (command === "dpkg-query") return ok(installed.has(args.at(-1)!) ? "install ok installed" : "unknown ok not-installed");
      if (command === "apt-get" && args[0] === "install") for (const name of args.slice(2)) installed.add(name);
      if (command === "useradd") {
        userExists = true;
        fs.mkdirSync(home, { recursive: true });
      }
      if (command === "id") return ok("dependabot-tracker\n");
      if (command === "usermod") {
        const range = args[1].split("-").map(Number);
        fs.appendFileSync(path.join(root, "etc", "subuid"), `dependabot-tracker:${range[0]}:${range[1] - range[0] + 1}\n`);
        fs.appendFileSync(path.join(root, "etc", "subgid"), `dependabot-tracker:${range[0]}:${range[1] - range[0] + 1}\n`);
      }
      if (command === "loginctl") fs.mkdirSync(path.join(root, "run", "user", String(UID)), { recursive: true });
      if (command === "runuser" && args.includes("info")) return ok("true\n");
      if (command === "ln") {
        fs.mkdirSync(path.dirname(args[2]), { recursive: true });
        fs.writeFileSync(args[2], fs.readFileSync(path.join(root, args[1])));
      }
      return ok();
    },
    ask: async () => assert.fail("no question without a terminal"),
    askSecret: async () => assert.fail("no question without a terminal"),
    say: () => {},
    waitHealthy: async () => true,
  };
  return { host, calls, root, packageRoot, home };
}

const has = (calls: string[][], ...prefix: string[]) => calls.some((call) => prefix.every((part, index) => call[index] === part));

test("setup installs the packages, the service account with a free sub-id range, the configuration, the first account, the unit and nginx", async () => {
  const temp = makeTempDir("tracker-setup-");
  process.env.SETUP_ADMIN_PASSWORD = PASSWORD;
  try {
    const machine = fakeMachine(temp.dir);
    fs.writeFileSync(path.join(machine.packageRoot, ".env"), "# réglages\nGITHUB_API_URL=https://ghe.example.com/api/v3\n");
    const dataDir = path.join(temp.dir, "data");
    const code = await runSetup(
      ["--app-url=https://deps.example.com", `--data-dir=${dataDir}`, "--admin-email=Admin@Example.com", "--admin-name=Admin", "--non-interactive"],
      machine.host
    );
    assert.equal(code, 0);

    assert.ok(has(machine.calls, "apt-get", "install", "-y", "socat", "certbot", "python3-certbot-nginx"), "the missing packages are installed");
    assert.ok(has(machine.calls, "useradd", "--system", "--user-group", "--create-home", "--home-dir", "/var/lib/dependabot-tracker"));
    assert.ok(has(machine.calls, "usermod", "--add-subuids", "365536-431071", "--add-subgids", "365536-431071", "dependabot-tracker"), "the range follows every existing one");
    assert.ok(has(machine.calls, "loginctl", "enable-linger", "dependabot-tracker"));
    assert.ok(has(machine.calls, "runuser", "-u", "dependabot-tracker", "--", "env", `XDG_RUNTIME_DIR=/run/user/${UID}`, "podman", "system", "migrate"));
    assert.ok(has(machine.calls, "systemctl", "restart", "dependabot-tracker"));
    assert.ok(has(machine.calls, "nginx", "-t"));
    assert.ok(has(machine.calls, "certbot", "--nginx", "-d", "deps.example.com", "--non-interactive", "--agree-tos", "-m", "admin@example.com"));

    const env = dotenv.parse(fs.readFileSync(path.join(machine.packageRoot, ".env"), "utf-8"));
    assert.equal(env.GITHUB_API_URL, "https://ghe.example.com/api/v3", "the other settings are kept");
    assert.equal(env.APP_URL, "https://deps.example.com");
    assert.equal(env.APP_PORT, "4700");
    assert.equal(env.DATA_DIR, dataDir);
    assert.equal(env.TRUSTED_PROXIES, "127.0.0.1");
    assert.equal(Buffer.from(env.VAULT_KEY, "base64").length, 32);
    assert.ok(env.AUTH_SECRET.length >= 32);
    assert.ok(has(machine.calls, "chown", "root:dependabot-tracker", path.join(machine.packageRoot, ".env")));

    const auth = createAuth(dataDir, readServerConfig(env));
    await migrateAuth(auth);
    assert.deepEqual((await listUsers(auth)).map((user) => user.email), ["admin@example.com"]);
    closeAuth(auth);

    const unit = fs.readFileSync(path.join(machine.root, "etc", "systemd", "system", "dependabot-tracker.service"), "utf-8");
    assert.match(unit, /^User=dependabot-tracker$/m);
    assert.match(unit, new RegExp(`^Environment=XDG_RUNTIME_DIR=/run/user/${UID}$`, "m"));
    assert.match(unit, /^NoNewPrivileges=false$/m);
    assert.match(unit, /^RestrictSUIDSGID=false$/m);
    assert.match(unit, /^ProtectSystem=strict$/m);
    assert.doesNotMatch(unit, /^(RestrictNamespaces|PrivateUsers|SystemCallFilter)=/m);
    const site = fs.readFileSync(path.join(machine.root, "etc", "nginx", "sites-enabled", "dependabot-tracker"), "utf-8");
    assert.match(site, /server_name deps\.example\.com;/);
    assert.match(site, /proxy_pass http:\/\/127\.0\.0\.1:4700;/);
  } finally {
    delete process.env.SETUP_ADMIN_PASSWORD;
    temp.cleanup();
  }
});

test("setup run again keeps the keys, the account, the sub-ids and a site nginx already serves", async () => {
  const temp = makeTempDir("tracker-setup-again-");
  process.env.SETUP_ADMIN_PASSWORD = PASSWORD;
  try {
    const first = fakeMachine(temp.dir);
    const dataDir = path.join(temp.dir, "data");
    assert.equal(await runSetup(["--app-url=https://deps.example.com", `--data-dir=${dataDir}`, "--admin-email=admin@example.com", "--admin-name=Admin", "--nginx=non", "--non-interactive"], first.host), 0);
    const before = dotenv.parse(fs.readFileSync(path.join(first.packageRoot, ".env"), "utf-8"));
    delete process.env.SETUP_ADMIN_PASSWORD;

    const again = fakeMachine(temp.dir, { userExists: true, installed: ["git", "podman", "uidmap", "passt", "slirp4netns", "catatonit", "bubblewrap", "socat", "nginx"] });
    fs.appendFileSync(path.join(again.root, "etc", "subuid"), "dependabot-tracker:500000:65536\n");
    fs.appendFileSync(path.join(again.root, "etc", "subgid"), "dependabot-tracker:500000:65536\n");
    fs.mkdirSync(path.join(again.root, "etc", "nginx", "sites-enabled"), { recursive: true });
    fs.writeFileSync(path.join(again.root, "etc", "nginx", "sites-enabled", "deps"), "server {\n  server_name deps.example.com;\n}\n");
    assert.equal(await runSetup(["--non-interactive"], again.host), 0);

    const after = dotenv.parse(fs.readFileSync(path.join(again.packageRoot, ".env"), "utf-8"));
    assert.equal(after.VAULT_KEY, before.VAULT_KEY);
    assert.equal(after.AUTH_SECRET, before.AUTH_SECRET);
    assert.equal(after.APP_URL, "https://deps.example.com");
    assert.ok(!has(again.calls, "apt-get"), "nothing to install");
    assert.ok(!has(again.calls, "useradd"));
    assert.ok(!has(again.calls, "usermod"));
    assert.ok(!has(again.calls, "nginx"), "the site nginx already serves is left alone");
    assert.ok(!has(again.calls, "certbot"));
    const auth = createAuth(dataDir, readServerConfig(after));
    await migrateAuth(auth);
    assert.equal((await listUsers(auth)).length, 1);
    closeAuth(auth);
  } finally {
    delete process.env.SETUP_ADMIN_PASSWORD;
    temp.cleanup();
  }
});

test("setup refuses a machine without Linux, without root, or an answer missing without a terminal", async () => {
  const temp = makeTempDir("tracker-setup-refused-");
  try {
    const machine = fakeMachine(temp.dir);
    assert.equal(await runSetup(["--non-interactive"], { ...machine.host, platform: "win32" }), 1);
    assert.equal(await runSetup(["--non-interactive"], { ...machine.host, isRoot: false }), 1);
    assert.equal(await runSetup(["--non-interactive"], machine.host), 1, "APP_URL has no default");
    assert.equal(await runSetup(["--app-url=http://deps.example.com", "--non-interactive"], machine.host), 1, "an http address is refused");
    assert.equal(await runSetup(["--admin-password=x"], machine.host), 1, "a password is never an argument");
    assert.deepEqual(machine.calls.filter((call) => call[0] !== "systemctl" && call[0] !== "getent"), [], "nothing is changed before the answers are complete");
  } finally {
    temp.cleanup();
  }
});

test("the sub-id range follows every existing range; the .env keeps its other lines", () => {
  assert.deepEqual(nextFreeSubIdRange("", ""), { start: 100000, count: 65536 });
  assert.deepEqual(nextFreeSubIdRange("a:100000:65536\n", "b:427680:65536\n"), { start: 493216, count: 65536 });
  assert.deepEqual(subIdRangesOf("a:100000:65536\nb:165536:65536\n", "b"), [{ start: 165536, count: 65536 }]);
  assert.equal(mergeEnvFile("# note\nAPP_PORT=1\nOTHER=x\n", { APP_PORT: "4700", APP_URL: "https://d.example.com" }), "# note\nAPP_PORT=4700\nOTHER=x\nAPP_URL=https://d.example.com\n");
  assert.equal(mergeEnvFile(undefined, { AUTH_SECRET: "a b#c" }), "AUTH_SECRET='a b#c'\n");
  assert.equal(dotenv.parse(mergeEnvFile(undefined, { DATA_DIR: "C:\\data dir\\x" })).DATA_DIR, "C:\\data dir\\x");
});

test("the unit opens the data directory to writes only when it is outside the home of the account", () => {
  const layout = { serviceUser: "t", serviceGroup: "t", uid: 990, home: "/var/lib/t", dataDir: "/var/lib/t/data", packageRoot: "/opt/t", nodePath: "/usr/bin/node", port: 4700 };
  assert.match(renderSystemdUnit(layout), /^ReadWritePaths=\/var\/lib\/t \/run\/user\/990$/m);
  assert.match(renderSystemdUnit({ ...layout, dataDir: "/srv/t" }), /^ReadWritePaths=\/var\/lib\/t \/srv\/t \/run\/user\/990$/m);
  assert.match(renderSystemdUnit(layout), /^ExecStart=\/usr\/bin\/node \/opt\/t\/dist\/src\/index\.js serve$/m);
});
