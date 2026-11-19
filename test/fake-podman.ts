import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Faux Podman des tests, lancé par `node fake-podman.js <journal> <arguments podman>` :
 * chaque appel est noté en JSON dans le fichier `<journal>`.
 *   `run`    lance la commande directement sur la machine, dans le dossier de
 *            l'hôte qui correspond au dossier de travail du conteneur d'après
 *            les montages `--volume`, avec les variables `--env` ; les chemins
 *            du conteneur des variables et des arguments sont traduits en
 *            chemins de l'hôte, et `/tmp` devient un dossier temporaire vide ;
 *   `info`   se dit rootless ;
 *   `pull`, `rm` et `build` réussissent sans rien faire (`build` note le
 *            contenu du Containerfile que désigne `--file`).
 */

const [logFile, subcommand, ...args] = process.argv.slice(2);

/** Options de `podman run` suivies d'une valeur. */
const VALUE_OPTIONS = new Set(["--name", "--tmpfs", "--volume", "--workdir", "--env", "--network"]);

function record(entry: Record<string, unknown>): void {
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
}

/** Argument passé à un shell Windows : entre guillemets s'il contient autre chose que des caractères sûrs. */
function quote(arg: string): string {
  return /^[A-Za-z0-9@/\\._:=^~+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

async function run(): Promise<number> {
  const mounts: [container: string, host: string][] = [];
  const env: Record<string, string> = {};
  let workdir = "/";
  let index = 0;
  for (; index < args.length && args[index].startsWith("--"); index++) {
    const [flag, inline] = args[index].split(/=(.*)/s, 2);
    if (!VALUE_OPTIONS.has(flag) || inline !== undefined) continue;
    const value = args[++index];
    if (flag === "--volume") {
      const separator = value.lastIndexOf(":/");
      mounts.push([value.slice(separator + 1), value.slice(0, separator)]);
    }
    if (flag === "--workdir") workdir = value;
    if (flag === "--env") {
      const [key, val] = value.split(/=(.*)/s, 2);
      env[key] = val;
    }
  }
  const image = args[index];
  const command = args.slice(index + 1);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-podman-tmp-"));
  mounts.push(["/tmp", tmp]);
  const toHost = (value: string) => {
    for (const [container, host] of mounts) {
      if (value === container) return host;
      if (value.startsWith(`${container}/`)) return path.join(host, value.slice(container.length + 1));
    }
    return value;
  };
  record({ subcommand: "run", image, workdir, env, command, args });
  const hostEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key !== "HOME").map(([key, value]) => [key, toHost(value)]));
  const [program, ...rest] = command.map(toHost);
  const windows = process.platform === "win32";
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(windows ? [program, ...rest].map(quote).join(" ") : program, windows ? [] : rest, {
        cwd: toHost(workdir),
        env: { ...process.env, ...hostEnv },
        shell: windows,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  switch (subcommand) {
    case "run":
      return run();
    case "info":
      record({ subcommand, args });
      process.stdout.write("true\n");
      return 0;
    case "build":
      record({ subcommand, args, containerfile: fs.readFileSync(args[args.indexOf("--file") + 1], "utf-8") });
      return 0;
    default:
      record({ subcommand, args });
      return 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(String(err?.stack ?? err));
    process.exit(1);
  }
);
