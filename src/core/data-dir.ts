import fs from "fs";
import os from "os";
import path from "path";

/** Droits du répertoire des données : lecture, écriture et parcours par le seul compte du serveur. */
const DATA_DIR_MODE = 0o700;

/**
 * Répertoire des données : MCP_DATA_DIR, puis `~/.mcp-dependabot-tracker`. Les
 * dépôts suivis ne dépendent d'aucun projet : le répertoire par défaut est
 * propre à l'utilisateur. Il est créé s'il n'existe pas, et réservé au compte
 * du serveur (droits 700) hors de Windows : il porte les comptes, les sessions,
 * les tokens et les scripts de déploiement.
 */
export function resolveDataDir(): string {
  const configured = process.env.MCP_DATA_DIR?.trim();
  const dir = configured ? path.resolve(configured) : path.join(os.homedir(), ".mcp-dependabot-tracker");
  fs.mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE });
  if (process.platform !== "win32") fs.chmodSync(dir, DATA_DIR_MODE);
  return dir;
}

/**
 * Dossier où chaque opération crée son clone, fixé par CLONE_DIR et créé s'il
 * n'existe pas. Lève une erreur si la variable n'est pas renseignée.
 */
export function resolveCloneDir(): string {
  const configured = process.env.CLONE_DIR?.trim();
  if (!configured) {
    throw new Error("CLONE_DIR is not set: declare the folder where the repositories are cloned for npm audit in the environment of the server.");
  }
  const dir = path.resolve(configured);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
