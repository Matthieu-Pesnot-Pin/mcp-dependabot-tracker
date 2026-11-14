import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { runCommand, tail, type CommandResult } from "./commands.js";
import { TrackerError } from "./errors.js";

/**
 * Commandes npm d'une opération : celles du tracker (`npm audit`, `npm audit
 * fix`) et celles lancées pour Claude pendant ses corrections, hors du bac à
 * sable de Claude Code, qui garde en lecture seule les manifestes, les lockfiles
 * et `node_modules`. Sous Linux, chaque commande tourne dans un bac à sable
 * bubblewrap du tracker : système en lecture seule (`/usr`, `/etc`, Node.js…),
 * clone et cache npm de l'opération en écriture, `/tmp` vide, aucun autre
 * dossier du serveur visible (ni les données du tracker, ni les autres clones),
 * environnement réduit à PATH, LANG, HOME et au cache npm. Ailleurs, la
 * commande tourne directement dans le clone, avec le cache de l'opération.
 */

/** Dossiers système montés en lecture seule, ou recréés en lien symbolique quand ils en sont un. */
const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/run/systemd/resolve"];

/** Bac à sable minimal, du type de ceux où le tracker lance les commandes npm sous Linux. */
const BWRAP_PROBE = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-user", "--unshare-pid", "--unshare-net", "true"];

/** Durée maximale du test de bubblewrap. */
const BWRAP_PROBE_TIMEOUT_MS = 10_000;

/**
 * Vérifie, sous Linux, que bubblewrap crée un bac à sable pour le compte et
 * avec les restrictions du serveur : le tracker y lance toutes les commandes
 * npm d'une opération, et Claude Code refuse de démarrer sans lui. Lève une
 * erreur qui dit quoi installer ou régler ; sans effet sur les autres systèmes.
 */
export function assertSandboxAvailable(platform: NodeJS.Platform = process.platform, command = "bwrap"): Promise<void> {
  if (platform !== "linux") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn(command, BWRAP_PROBE, { stdio: ["ignore", "ignore", "pipe"], timeout: BWRAP_PROBE_TIMEOUT_MS });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (err: any) =>
      reject(
        new TrackerError(
          err.code === "ENOENT"
            ? "The npm commands of an operation need bubblewrap (bwrap), which isolates them on Linux, and it is not in the PATH of the server. Install it on the server: sudo apt-get install -y bubblewrap socat"
            : `The npm commands of an operation need bubblewrap (bwrap), which could not be started: ${err.message}`
        )
      )
    );
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new TrackerError(
          `bubblewrap (bwrap) is installed but cannot create a sandbox for the account of the server${stderr.trim() ? `: ${tail(stderr, 3)}` : "."} ` +
            "Check the AppArmor restriction on user namespaces (kernel.apparmor_restrict_unprivileged_userns on Ubuntu 24.04 and later) and the hardening of the service (RestrictNamespaces, PrivateUsers, SystemCallFilter)."
        )
      );
    });
  });
}

export interface NpmSandbox {
  /** Clone du dépôt, seul dossier du projet en écriture. */
  root: string;
  /** Cache npm de l'opération, hors du clone. */
  cache: string;
}

/** Cache npm d'une opération, dans son répertoire temporaire, à côté du clone. */
export const NPM_CACHE_DIR = "npm-cache";

export interface NpmRunOptions {
  /** Variables propres à la commande, en plus de celles de `npmEnv`. */
  env?: Record<string, string>;
  /** Annulation de l'opération : arrête la commande. */
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
}

/** Variables transmises à npm : chemins, langue, HOME, cache de l'opération, mode CI pour que les tests ne restent pas en veille, puis `extra`. */
function npmEnv(sandbox: NpmSandbox, home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: home,
    npm_config_cache: sandbox.cache,
    npm_config_update_notifier: "false",
    CI: "true",
    ...extra,
  };
}

/** Préfixe d'installation de Node.js (`<préfixe>/bin/node`), où se trouve aussi npm. */
function nodePrefix(): string {
  return path.dirname(path.dirname(fs.realpathSync(process.execPath)));
}

/** Arguments de bubblewrap pour lancer `npm <args>` dans `cwd`, un dossier du clone, avec les variables `extraEnv` en plus. */
export function bwrapArgs(sandbox: NpmSandbox, cwd: string, args: string[], extraEnv: Record<string, string> = {}): string[] {
  const mounts: string[] = [];
  for (const dir of [...SYSTEM_DIRS, nodePrefix()]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) mounts.push("--symlink", fs.readlinkSync(dir), dir);
    else mounts.push("--ro-bind", dir, dir);
  }
  const env = Object.entries(npmEnv(sandbox, "/tmp", extraEnv)).flatMap(([name, value]) => ["--setenv", name, value]);
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    ...mounts,
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--bind", sandbox.root, sandbox.root,
    "--bind", sandbox.cache, sandbox.cache,
    "--chdir", cwd,
    "--clearenv",
    ...env,
    "npm",
    ...args,
  ];
}

/**
 * Dossier d'un projet du clone, d'après son chemin relatif (`""` pour la
 * racine) ; lève une erreur hors du clone, dans `node_modules` ou sans
 * `package.json`.
 */
export function projectDir(sandbox: NpmSandbox, project: string): string {
  const dir = path.resolve(sandbox.root, project);
  const relative = path.relative(sandbox.root, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).includes("node_modules")) {
    throw new TrackerError(`"${project}" is not a project folder of the repository.`);
  }
  if (!fs.existsSync(path.join(dir, "package.json"))) throw new TrackerError(`"${project || "."}" has no package.json.`);
  return dir;
}

/** Lance `npm <args>` dans un projet du clone et rend son code de sortie et ses sorties. */
export function runSandboxedNpm(sandbox: NpmSandbox, project: string, args: string[], options: NpmRunOptions = {}): Promise<CommandResult> {
  const cwd = projectDir(sandbox, project);
  fs.mkdirSync(sandbox.cache, { recursive: true });
  if ((options.platform ?? process.platform) === "linux") {
    return runCommand("bwrap", bwrapArgs(sandbox, cwd, args, options.env), { cwd: sandbox.root, env: {}, signal: options.signal });
  }
  return runCommand("npm", args, { cwd, env: npmEnv(sandbox, sandbox.cache, options.env), signal: options.signal });
}
