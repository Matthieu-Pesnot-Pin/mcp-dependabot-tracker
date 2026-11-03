import fs from "fs";
import path from "path";
import { runCommand, type CommandResult } from "./commands.js";
import { TrackerError } from "./errors.js";

/**
 * Commandes npm lancées pour Claude pendant ses corrections, hors du bac à sable
 * de Claude Code, qui garde en lecture seule les manifestes, les lockfiles et
 * `node_modules`. Sous Linux, chaque commande tourne dans un bac à sable
 * bubblewrap du tracker : système en lecture seule (`/usr`, `/etc`, Node.js…),
 * clone et cache npm de l'opération en écriture, `/tmp` vide, aucun autre
 * dossier du serveur visible (ni les données du tracker, ni les autres clones),
 * environnement réduit à PATH, LANG, HOME et au cache npm. Ailleurs, la
 * commande tourne directement dans le clone, avec le cache de l'opération.
 */

/** Dossiers système montés en lecture seule, ou recréés en lien symbolique quand ils en sont un. */
const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/run/systemd/resolve"];

export interface NpmSandbox {
  /** Clone du dépôt, seul dossier du projet en écriture. */
  root: string;
  /** Cache npm de l'opération, hors du clone. */
  cache: string;
}

/** Variables transmises à npm : chemins, langue, HOME dans `/tmp`, cache de l'opération, mode CI pour que les tests ne restent pas en veille. */
function npmEnv(sandbox: NpmSandbox, home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: home,
    npm_config_cache: sandbox.cache,
    npm_config_update_notifier: "false",
    CI: "true",
  };
}

/** Préfixe d'installation de Node.js (`<préfixe>/bin/node`), où se trouve aussi npm. */
function nodePrefix(): string {
  return path.dirname(path.dirname(fs.realpathSync(process.execPath)));
}

/** Arguments de bubblewrap pour lancer `npm <args>` dans `cwd`, un dossier du clone. */
export function bwrapArgs(sandbox: NpmSandbox, cwd: string, args: string[]): string[] {
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
  const env = Object.entries(npmEnv(sandbox, "/tmp")).flatMap(([name, value]) => ["--setenv", name, value]);
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
export function runSandboxedNpm(sandbox: NpmSandbox, project: string, args: string[], platform: NodeJS.Platform = process.platform): Promise<CommandResult> {
  const cwd = projectDir(sandbox, project);
  fs.mkdirSync(sandbox.cache, { recursive: true });
  if (platform === "linux") return runCommand("bwrap", bwrapArgs(sandbox, cwd, args), { cwd: sandbox.root, env: {} });
  return runCommand("npm", args, { cwd, env: npmEnv(sandbox, sandbox.cache) });
}
