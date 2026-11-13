import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import ssh2 from "ssh2";

/** Ligne d'un fichier de clés : options éventuelles, puis la clé publique. */
function parseKeyLine(line: string): { options: string; key: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = /^(?:(\S+)\s+)?((?:ssh-|ecdsa-)\S+\s+\S+)/.exec(trimmed);
  if (!match) return null;
  return { options: match[1] ?? "", key: match[2] };
}

/**
 * Faux serveur SSH des tests. Il accepte les clés du fichier dédié
 * `<home>/.ssh/authorized_keys.d/dependabot-tracker`, en respectant leur option
 * `from`, et exécute chaque commande avec bash dans `home`, avec HOME et
 * SSH_CLIENT définis comme sshd le fait. Fermer le canal tue la commande.
 */
export class FakeSshServer {
  readonly home: string;
  readonly hostKey = ssh2.utils.generateKeyPairSync("ed25519");
  private server: ssh2.Server | null = null;
  private readonly children = new Set<ChildProcess>();
  port = 0;

  constructor(home: string) {
    this.home = home;
    fs.mkdirSync(home, { recursive: true });
  }

  get keyFile(): string {
    return path.join(this.home, ".ssh", "authorized_keys.d", "dependabot-tracker");
  }

  /** Écrit le fichier dédié, comme le fait la commande d'installation. */
  install(line: string): void {
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    fs.writeFileSync(this.keyFile, `${line}\n`);
  }

  private allowed(ip: string, algo: string, data: Buffer): ssh2.ParsedKey | null {
    if (!fs.existsSync(this.keyFile)) return null;
    for (const raw of fs.readFileSync(this.keyFile, "utf-8").split("\n")) {
      const line = parseKeyLine(raw);
      if (!line) continue;
      const from = /(?:^|,)from="([^"]*)"/.exec(line.options)?.[1];
      if (from !== undefined && from !== ip) continue;
      const parsed = ssh2.utils.parseKey(line.key);
      if (parsed instanceof Error) continue;
      if (parsed.type === algo && Buffer.compare(parsed.getPublicSSH(), data) === 0) return parsed;
    }
    return null;
  }

  async start(): Promise<void> {
    this.server = new ssh2.Server({ hostKeys: [this.hostKey.private] }, (client, info) => {
      client.on("error", () => undefined);
      client.on("authentication", (ctx) => {
        if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
        const key = this.allowed(info.ip, ctx.key.algo, ctx.key.data);
        if (!key) return ctx.reject(["publickey"]);
        if (ctx.signature && key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(["publickey"]);
        ctx.accept();
      });
      client.on("ready", () => {
        client.on("session", (acceptSession) => {
          const session = acceptSession();
          session.on("exec", (accept, _reject, exec) => {
            const stream = accept();
            const child = spawn("bash", ["-c", exec.command], {
              cwd: this.home,
              env: { ...process.env, HOME: this.home, SSH_CLIENT: `${info.ip} ${info.port} 22` },
              stdio: ["pipe", "pipe", "pipe"],
            });
            this.children.add(child);
            stream.pipe(child.stdin!);
            child.stdout!.pipe(stream, { end: false });
            child.stderr!.pipe(stream.stderr, { end: false });
            child.on("close", (code) => {
              this.children.delete(child);
              try {
                stream.exit(code ?? 255);
                stream.end();
              } catch {
                // Canal déjà fermé par le client.
              }
            });
            stream.on("close", () => {
              if (child.exitCode === null) child.kill("SIGKILL");
            });
          });
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const child of this.children) child.kill("SIGKILL");
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
