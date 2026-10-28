import fs from "fs";
import os from "os";
import path from "path";

/**
 * Répertoire des données : MCP_DATA_DIR, puis `~/.mcp-dependabot-tracker`. Les
 * dépôts suivis ne dépendent d'aucun projet : le répertoire par défaut est
 * propre à l'utilisateur.
 */
export function resolveDataDir(): string {
  const configured = process.env.MCP_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".mcp-dependabot-tracker");
}

/**
 * Dossier où chaque opération crée son clone, fixé par CLONE_DIR et créé s'il
 * n'existe pas. Lève une erreur si la variable n'est pas renseignée.
 */
export function resolveCloneDir(): string {
  const configured = process.env.CLONE_DIR?.trim();
  if (!configured) {
    throw new Error("CLONE_DIR is not set: declare the folder where the repositories are cloned for npm audit in the env block of mcp-dependabot-tracker.");
  }
  const dir = path.resolve(configured);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
