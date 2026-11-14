import { spawn, spawnSync } from "child_process";
import { TrackerError } from "./errors.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Commande interrompue par l'annulation de l'opération. */
export class CommandAbortedError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "CommandAbortedError";
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Arrête le processus et ses enfants : sous Windows, `npm` tourne dans un `cmd.exe` qui ne transmet pas le signal. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Le groupe de processus est déjà terminé.
  }
}

/**
 * Variables du serveur transmises aux commandes : chemins et dossiers du
 * système, compte, langue, proxy et certificats. Aucun secret du serveur
 * (GITHUB_TOKEN, VAULT_KEY, AUTH_SECRET…) n'en fait partie.
 */
const PASSED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSL_CAINFO",
];

/** Environnement du serveur transmis aux commandes : les seules variables de `PASSED_ENV`. */
function inheritedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSED_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

/**
 * Lance `git`, `npm` ou `bwrap` sans shell, et attend sa fin. La commande reçoit
 * les variables système du serveur (`PASSED_ENV`), sans aucun de ses secrets, plus `options.env`. Sous Windows,
 * `npm` est un script `.cmd` que Node ne lance qu'à travers un shell : ses
 * arguments sont alors des options fixes, jamais une valeur venue de
 * l'utilisateur. Le code de sortie n'est pas interprété ici ; un dépassement de
 * `timeoutMs` ou l'annulation par `signal` arrêtent la commande.
 */
export function runCommand(command: "git" | "npm" | "bwrap", args: string[], options: CommandOptions): Promise<CommandResult> {
  const viaShell = command === "npm" && process.platform === "win32";
  if (viaShell && args.some((arg) => !/^[A-Za-z0-9=._-]+$/.test(arg))) {
    throw new TrackerError(`Refused npm argument list: ${JSON.stringify(args)}.`);
  }
  if (options.signal?.aborted) return Promise.reject(new CommandAbortedError());

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...inheritedEnv(), ...options.env },
      shell: viaShell,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const stop = () => {
      if (child.pid !== undefined && child.exitCode === null) killTree(child.pid);
    };
    const onAbort = () => stop();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err: any) => {
      finish(() =>
        reject(
          err.code === "ENOENT"
            ? new TrackerError(`"${command}" is not installed or not in the PATH of the server.`)
            : new TrackerError(`Could not run ${command}: ${err.message}`)
        )
      );
    });
    child.on("close", (code) => {
      finish(() => {
        if (options.signal?.aborted) return reject(new CommandAbortedError());
        if (timedOut) return reject(new TrackerError(`${command} ${args.join(" ")} did not finish in ${Math.round(timeoutMs / 1000)} s and was stopped.`));
        resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf-8"), stderr: Buffer.concat(stderr).toString("utf-8") });
      });
    });
  });
}

/** Dernières lignes non vides d'une sortie, pour un message d'erreur ou le journal. */
export function tail(text: string, lines = 12): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-lines)
    .join("\n");
}
