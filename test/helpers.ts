import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Point d'entrée compilé du serveur MCP. */
export const SERVER_ENTRY = path.resolve(__dirname, "../src/index.js");

/** Projet npm vulnérable : lodash (corrigé par `npm audit fix`) et nth-check (corrigé seulement par `--force`). */
export const VULNERABLE_FIXTURE = path.resolve(__dirname, "../../test/fixtures/vulnerable");

/** Crée un répertoire temporaire et renvoie sa fonction de suppression. */
export function makeTempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Port TCP libre attribué par le système. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/** Vrai si le registre npm répond : `npm audit` en a besoin. */
export async function npmRegistryReachable(): Promise<boolean> {
  try {
    const response = await fetch("https://registry.npmjs.org/-/ping", { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Attend que `predicate` soit vrai, en le réévaluant toutes les 200 ms. */
export async function waitFor<T>(what: string, fn: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${what}. Last value: ${JSON.stringify(last)?.slice(0, 2000)}`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Dépôts distants locaux, servis par `file://` : `<root>/<propriétaire>/<nom>.git`.
 * `serverUrl` remplace https://github.com dans les URL de clone.
 */
export class LocalRemotes {
  readonly root: string;
  readonly serverUrl: string;

  constructor(root: string) {
    this.root = root;
    this.serverUrl = pathToFileURL(root).href.replace(/\/+$/, "");
  }

  barePath(owner: string, name: string): string {
    return path.join(this.root, owner, `${name}.git`);
  }

  /** Crée le dépôt nu, avec un commit sur `branch` qui contient `files` (chemin relatif → dossier source copié). */
  create(owner: string, name: string, branch: string, files: Record<string, string>): void {
    const bare = this.barePath(owner, name);
    fs.mkdirSync(bare, { recursive: true });
    git(bare, ["init", "--bare", "-b", branch]);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-remote-work-"));
    try {
      git(work, ["init", "-b", branch]);
      for (const [target, source] of Object.entries(files)) {
        fs.cpSync(source, path.join(work, target), { recursive: true });
      }
      git(work, ["add", "-A"]);
      git(work, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", "commit", "-m", "initial"]);
      git(work, ["push", bare, `HEAD:refs/heads/${branch}`]);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  branches(owner: string, name: string): string[] {
    return git(this.barePath(owner, name), ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .split("\n")
      .filter((line) => line !== "");
  }

  /** Contenu d'un fichier sur une branche du dépôt nu. */
  show(owner: string, name: string, ref: string, file: string): string {
    return git(this.barePath(owner, name), ["show", `${ref}:${file}`]);
  }

  log(owner: string, name: string, ref: string): string {
    return git(this.barePath(owner, name), ["log", "--format=%an <%ae>|%s", ref]);
  }
}

export interface FakeAlert {
  number: number;
  severity: string;
  package: string;
  summary: string;
}

interface FakeRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  alerts: FakeAlert[];
  alertsStatus?: number;
}

/** Nombre d'alertes par page : petit, pour exercer la pagination par `Link`. */
const FAKE_PAGE_SIZE = 2;

/**
 * Fausse API GitHub : dépôts, alertes Dependabot paginées, utilisateur du token
 * et création de pull requests, qu'elle enregistre.
 */
export class FakeGitHub {
  readonly repos = new Map<string, FakeRepo>();
  readonly pulls: { repo: string; title: string; head: string; base: string; body: string; number: number }[] = [];
  readonly token = "test-token";
  private server: http.Server | null = null;
  url = "";

  addRepo(owner: string, name: string, defaultBranch: string, alerts: FakeAlert[]): void {
    this.repos.set(`${owner}/${name}`.toLowerCase(), { owner, name, defaultBranch, alerts });
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as net.AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.send(res, 401, { message: "Bad credentials" });
    const url = new URL(req.url ?? "/", this.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/user") {
      return this.send(res, 200, { login: "tracker-bot", id: 4242, name: "Tracker Bot" });
    }
    if (parts[0] !== "repos" || parts.length < 3) return this.send(res, 404, { message: "Not Found" });
    const repo = this.repos.get(`${parts[1]}/${parts[2]}`.toLowerCase());
    if (!repo) return this.send(res, 404, { message: "Not Found" });

    if (req.method === "GET" && parts.length === 3) {
      return this.send(res, 200, { name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, default_branch: repo.defaultBranch });
    }
    if (req.method === "GET" && parts[3] === "dependabot" && parts[4] === "alerts") {
      if (repo.alertsStatus) return this.send(res, repo.alertsStatus, { message: "Dependabot alerts are disabled for this repository." });
      const start = Number(url.searchParams.get("after") ?? "0");
      const page = repo.alerts.slice(start, start + FAKE_PAGE_SIZE).map((alert) => ({
        number: alert.number,
        state: "open",
        html_url: `https://github.com/${repo.owner}/${repo.name}/security/dependabot/${alert.number}`,
        dependency: { package: { ecosystem: "npm", name: alert.package }, manifest_path: "package-lock.json", scope: "runtime" },
        security_advisory: { ghsa_id: `GHSA-${alert.number}`, summary: alert.summary, severity: alert.severity },
        security_vulnerability: { severity: alert.severity, vulnerable_version_range: "< 9", first_patched_version: { identifier: "9.0.0" } },
      }));
      const next: Record<string, string> = start + FAKE_PAGE_SIZE < repo.alerts.length ? { Link:`<${this.url}${url.pathname}?state=open&per_page=100&after=${start + FAKE_PAGE_SIZE}>; rel="next"` } : {};
      return this.send(res, 200, page, next);
    }
    if (req.method === "POST" && parts[3] === "pulls") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const number = this.pulls.length + 1;
      this.pulls.push({ repo: `${repo.owner}/${repo.name}`, number, ...body });
      return this.send(res, 201, { number, html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}` });
    }
    return this.send(res, 404, { message: "Not Found" });
  }
}

/**
 * Client JSON-RPC minimal sur stdio : lance le serveur MCP compilé avec
 * l'environnement fourni et associe chaque réponse à sa requête par `id`.
 */
export class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (message: any) => void>();
  readonly stderr: string[] = [];
  readonly strayStdout: string[] = [];

  constructor(env: Record<string, string | undefined>) {
    this.child = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding("utf-8");
    this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") {
        try {
          const message = JSON.parse(line);
          const resolve = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
          if (resolve) {
            this.pending.delete(message.id);
            resolve(message);
          }
        } catch {
          // Toute ligne non JSON-RPC sur stdout casse le protocole MCP : elle est conservée pour les assertions.
          this.strayStdout.push(line);
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  request(method: string, params?: unknown, timeoutMs = 20_000): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      this.child.stdin.write(payload);
    });
  }

  notify(method: string, params?: unknown) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** Handshake MCP : `initialize` puis `notifications/initialized`. */
  async initialize(clientName: string) {
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } });
    this.notify("notifications/initialized");
  }

  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<{ text: string; isError: boolean }> {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    return { text: result.content.map((entry: { text: string }) => entry.text).join("\n"), isError: result.isError === true };
  }

  /** Ferme stdin (le serveur arrête son GUI worker) puis attend la fin du processus. */
  async stop() {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
}

/** Environnement du processus courant sans les variables qui activent la GUI, fixent les répertoires ou visent GitHub. */
export function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "PROXY_URL",
    "APP_PORT",
    "APP_PATH",
    "APP_PATH_PREFIX",
    "APP_NAME",
    "APP_GROUP",
    "CLONE_DIR",
    "MCP_DATA_DIR",
    "MCP_LOG_DIR",
    "GITHUB_TOKEN",
    "GITHUB_API_URL",
    "GITHUB_SERVER_URL",
  ]) {
    delete env[key];
  }
  return env;
}
