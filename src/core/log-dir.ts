import path from "path";
import { resolveDataDir } from "./data-dir.js";

/** Répertoire des logs : MCP_LOG_DIR s'il est renseigné, sinon <dataDir>/logs. */
export function resolveLogDir(): string {
  const configured = process.env.MCP_LOG_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(resolveDataDir(), "logs");
}
