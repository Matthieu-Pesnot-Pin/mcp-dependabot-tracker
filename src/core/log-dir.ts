import path from "path";
import { resolveDataDir } from "./data-dir.js";

/**
 * Répertoire des logs : MCP_LOG_DIR s'il est renseigné, sinon <dataDir>/logs.
 * Lu depuis process.env au démarrage, avant le chargement du .env du package :
 * la variable vient donc de la déclaration du serveur dans le client MCP.
 */
export function resolveLogDir(): string {
  const configured = process.env.MCP_LOG_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(resolveDataDir(), "logs");
}
