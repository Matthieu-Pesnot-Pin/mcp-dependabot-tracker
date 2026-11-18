import crypto from "crypto";
import fs from "fs";
import path from "path";
import { runCommand, tail, type CommandResult } from "./commands.js";
import { TrackerError } from "./errors.js";

/**
 * Conteneurs jetables des commandes des gestionnaires de paquets d'une
 * opération. Chaque commande tourne dans un conteneur Podman rootless créé pour
 * elle et supprimé à sa fin : le clone de l'opération est monté en écriture sur
 * `/work`, son cache sur `/cache`, et rien d'autre de l'hôte n'est visible.
 * Le conteneur n'a aucune capacité, ne peut pas gagner de privilèges, garde son
 * système de fichiers en lecture seule hors de ces montages et d'un `/tmp`
 * vide, et tourne sous l'identité du compte du serveur, si bien que les
 * fichiers écrits dans le clone lui appartiennent. Il ne reçoit aucune variable
 * du serveur hormis le proxy : ni token, ni secret.
 */

/** Commande qui lance Podman : `["podman"]` pour le serveur. */
export interface ContainerRuntime {
  command: string[];
}

export const PODMAN: ContainerRuntime = { command: ["podman"] };

/** Dossiers de l'hôte montés dans le conteneur. */
export interface Workspace {
  /** Clone du dépôt. */
  root: string;
  /** Cache de l'opération (npm, pnpm, Composer), hors du clone. */
  cache: string;
}

/** Cache d'une opération, dans son répertoire temporaire, à côté du clone. */
export const CACHE_DIR = "cache";

/** Point de montage du clone dans le conteneur. */
export const CLONE_MOUNT = "/work";

/** Point de montage du cache de l'opération dans le conteneur. */
export const CACHE_MOUNT = "/cache";

/** Commande à lancer dans un conteneur. */
export interface ContainerCommand {
  image: string;
  /** Dossier de travail, relatif au clone : `""` pour la racine. */
  cwd: string;
  command: string[];
  env?: Record<string, string>;
}

export interface ContainerRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Variables de proxy du serveur transmises au conteneur. */
const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

/** Durée maximale du téléchargement ou de la construction d'une image. */
const IMAGE_TIMEOUT_MS = 15 * 60_000;

/** Chemin, dans le conteneur, d'un dossier du clone. */
export function containerPath(relative: string): string {
  return path.posix.join(CLONE_MOUNT, relative.split(path.sep).join("/"));
}

/**
 * Dossier d'un projet du clone, d'après son chemin relatif (`""` pour la
 * racine) ; lève une erreur hors du clone, dans `node_modules` ou `vendor`, ou
 * sans le fichier `manifest`.
 */
export function projectDir(workspace: Workspace, project: string, manifest: string): string {
  const dir = path.resolve(workspace.root, project);
  const relative = path.relative(workspace.root, dir);
  const parts = relative.split(path.sep);
  if (relative.startsWith("..") || path.isAbsolute(relative) || parts.includes("node_modules") || parts.includes("vendor")) {
    throw new TrackerError(`"${project}" is not a project folder of the repository.`);
  }
  if (!fs.existsSync(path.join(dir, manifest))) throw new TrackerError(`"${project || "."}" has no ${manifest}.`);
  return dir;
}

/** Arguments de `podman run` pour la commande `spec`, dans un conteneur nommé `name`. */
export function runArgs(workspace: Workspace, name: string, spec: ContainerCommand): string[] {
  const proxy = Object.fromEntries(PROXY_ENV.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]!]));
  const env = { ...proxy, HOME: "/tmp", LANG: "C.UTF-8", CI: "true", ...spec.env };
  return [
    "run",
    "--rm",
    "--init",
    "--name", name,
    "--pull=never",
    "--userns=keep-id",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,mode=1777",
    "--volume", `${workspace.root}:${CLONE_MOUNT}`,
    "--volume", `${workspace.cache}:${CACHE_MOUNT}`,
    "--workdir", containerPath(spec.cwd),
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    spec.image,
    ...spec.command,
  ];
}

function podman(runtime: ContainerRuntime, args: string[], options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; stdin?: string }): Promise<CommandResult> {
  const [command, ...prefix] = runtime.command;
  return runCommand(command, [...prefix, ...args], { cwd: options.cwd, signal: options.signal, timeoutMs: options.timeoutMs, stdin: options.stdin });
}

/** Supprime un conteneur, qu'il tourne encore ou non. */
async function removeContainer(runtime: ContainerRuntime, name: string, cwd: string): Promise<void> {
  await podman(runtime, ["rm", "--force", "--ignore", "--time", "0", name], { cwd }).catch(() => undefined);
}

/**
 * Lance `spec` dans un conteneur jetable et rend son code de sortie et ses
 * sorties. Une annulation ou un dépassement de délai supprime le conteneur,
 * qui survivrait sinon à l'arrêt du client `podman`.
 */
export async function runInContainer(runtime: ContainerRuntime, workspace: Workspace, spec: ContainerCommand, options: ContainerRunOptions = {}): Promise<CommandResult> {
  fs.mkdirSync(workspace.cache, { recursive: true });
  const name = `dependabot-tracker-${crypto.randomBytes(6).toString("hex")}`;
  try {
    return await podman(runtime, runArgs(workspace, name, spec), { cwd: workspace.root, signal: options.signal, timeoutMs: options.timeoutMs });
  } catch (err) {
    await removeContainer(runtime, name, workspace.root);
    throw err;
  }
}

/** Télécharge la dernière version de l'image `image`. */
export async function pullImage(runtime: ContainerRuntime, image: string, cwd: string, signal?: AbortSignal): Promise<void> {
  const result = await podman(runtime, ["pull", "--quiet", image], { cwd, signal, timeoutMs: IMAGE_TIMEOUT_MS });
  if (result.code !== 0) throw new TrackerError(`podman pull ${image} failed: ${tail(result.stderr) || tail(result.stdout)}`);
}

/** Construit l'image `tag` à partir du Containerfile `containerfile`, dont les images de base sont mises à jour. */
export async function buildImage(runtime: ContainerRuntime, tag: string, containerfile: string, cwd: string, signal?: AbortSignal): Promise<void> {
  const result = await podman(runtime, ["build", "--pull=newer", "--quiet", "--tag", tag, "--file", "-", cwd], { cwd, signal, timeoutMs: IMAGE_TIMEOUT_MS, stdin: containerfile });
  if (result.code !== 0) throw new TrackerError(`podman build ${tag} failed: ${tail(result.stderr) || tail(result.stdout)}`);
}

/**
 * Vérifie que Podman est installé et tourne en mode rootless ; lève une erreur
 * qui dit quoi installer ou régler.
 */
export async function assertContainersAvailable(runtime: ContainerRuntime, cwd: string): Promise<void> {
  let result: CommandResult;
  try {
    result = await podman(runtime, ["info", "--format", "{{.Host.Security.Rootless}}"], { cwd, timeoutMs: 60_000 });
  } catch (err: any) {
    throw new TrackerError(`The package manager commands of an operation run in Podman containers, and Podman cannot be started: ${err?.message ?? err} Install it on the server: sudo apt-get install -y podman uidmap passt`);
  }
  if (result.code !== 0) throw new TrackerError(`podman info failed: ${tail(result.stderr) || tail(result.stdout)}`);
  if (result.stdout.trim() !== "true") {
    throw new TrackerError("Podman runs rootful: the server must run under an unprivileged account, whose containers are rootless.");
  }
}
