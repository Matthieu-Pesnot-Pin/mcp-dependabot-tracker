import fs from "fs";
import path from "path";

/** Droits du répertoire des données : lecture, écriture et parcours par le seul compte du serveur. */
const DATA_DIR_MODE = 0o700;

/** Sous-dossier du répertoire des données où chaque opération crée son clone. */
const CLONES_SUBDIR = "clones";

/**
 * Répertoire des données, fixé par DATA_DIR. Il est créé s'il n'existe pas, et
 * réservé au compte du serveur (droits 700) hors de Windows : il porte les
 * comptes, les sessions, les tokens, les scripts de déploiement et les clones.
 * Lève une erreur si la variable n'est pas renseignée.
 */
export function resolveDataDir(): string {
  const configured = process.env.DATA_DIR?.trim();
  if (!configured) {
    throw new Error("DATA_DIR is not set. It is the folder where the accounts, the sessions, the tokens, the deployment scripts and the repository clones are stored.");
  }
  const dir = path.resolve(configured);
  fs.mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE });
  if (process.platform !== "win32") fs.chmodSync(dir, DATA_DIR_MODE);
  return dir;
}

/** Dossier où chaque opération crée son clone : `<dataDir>/clones`, créé s'il n'existe pas. */
export function resolveCloneDir(dataDir: string): string {
  const dir = path.join(dataDir, CLONES_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
