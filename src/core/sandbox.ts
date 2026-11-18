import { spawn } from "child_process";
import { tail } from "./commands.js";
import { TrackerError } from "./errors.js";

/** Bac à sable minimal, du type de ceux que Claude Code crée sous Linux. */
const BWRAP_PROBE = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-user", "--unshare-pid", "--unshare-net", "true"];

/** Durée maximale du test de bubblewrap. */
const BWRAP_PROBE_TIMEOUT_MS = 10_000;

/**
 * Vérifie, sous Linux, que bubblewrap crée un bac à sable pour le compte et
 * avec les restrictions du serveur : avec `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`,
 * Claude Code refuse de démarrer sans lui. Lève une erreur qui dit quoi
 * installer ou régler ; sans effet sur les autres systèmes.
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
            ? "The fixes by Claude need bubblewrap (bwrap), which Claude Code requires on Linux, and it is not in the PATH of the server. Install it on the server: sudo apt-get install -y bubblewrap socat"
            : `The fixes by Claude need bubblewrap (bwrap), which could not be started: ${err.message}`
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
