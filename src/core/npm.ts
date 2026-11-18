import { CACHE_MOUNT, projectDir, runInContainer, type ContainerRuntime, type Workspace } from "./containers.js";
import type { CommandResult } from "./commands.js";

/** Image des commandes npm : Node.js LTS, npm compris. */
export const NODE_IMAGE = "docker.io/library/node:26-slim";

export interface NpmRunOptions {
  /** Variables propres à la commande. */
  env?: Record<string, string>;
  /** Annulation de l'opération : arrête la commande. */
  signal?: AbortSignal;
}

/**
 * Lance `npm <args>` dans un projet du clone (`""` pour la racine), dans un
 * conteneur jetable, avec le cache npm de l'opération ; lève une erreur si le
 * dossier n'est pas un projet npm du clone.
 */
export function runNpm(runtime: ContainerRuntime, workspace: Workspace, project: string, args: string[], options: NpmRunOptions = {}): Promise<CommandResult> {
  projectDir(workspace, project, "package.json");
  const env = { npm_config_cache: `${CACHE_MOUNT}/npm`, npm_config_update_notifier: "false", ...options.env };
  return runInContainer(runtime, workspace, { image: NODE_IMAGE, cwd: project, command: ["npm", ...args], env }, { signal: options.signal });
}
