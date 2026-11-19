import path from "path";
import type { Change, ManagerId, Project } from "../../../shared/schemas/model.schema.js";
import { composer } from "./composer.js";
import { npm } from "./npm.js";
import { pnpm } from "./pnpm.js";
import type { Lockfile, PackageManager } from "./types.js";

/** Gestionnaires de paquets pris en charge, dans l'ordre où leurs projets sont traités. */
export const PACKAGE_MANAGERS: PackageManager[] = [npm, pnpm, composer];

/** Gestionnaire d'identifiant `id`. */
export function managerOf(id: ManagerId): PackageManager {
  const manager = PACKAGE_MANAGERS.find((candidate) => candidate.id === id);
  if (!manager) throw new Error(`Unknown package manager: ${id}`);
  return manager;
}

/** Projets d'un dépôt d'après ses fichiers suivis : chaque dossier qui suit le lockfile d'un gestionnaire. */
export function detectProjects(files: string[]): Project[] {
  const projects: Project[] = [];
  for (const manager of PACKAGE_MANAGERS) {
    for (const file of files) {
      if (path.posix.basename(file) !== manager.lockfile) continue;
      const dir = path.posix.dirname(file);
      projects.push({ path: dir === "." ? "" : dir, manager: manager.id });
    }
  }
  return projects.sort((a, b) => a.path.localeCompare(b.path) || PACKAGE_MANAGERS.indexOf(managerOf(a.manager)) - PACKAGE_MANAGERS.indexOf(managerOf(b.manager)));
}

/** Dossiers de dépendances installées d'un projet, relatifs à la racine du clone : jamais commités. */
export function installedDirs(project: Project): string[] {
  return project.manager === "composer" ? [path.posix.join(project.path, "vendor")] : [];
}

/** Lockfile d'un projet, relatif à la racine du clone. */
export function lockfilePath(project: Project): string {
  return path.posix.join(project.path, managerOf(project.manager).lockfile);
}

/** Paquets dont la version diffère entre deux lockfiles d'un projet ; `from` null pour un ajout, `to` null pour un retrait. */
export function diffLockfiles(before: Lockfile, after: Lockfile, project: Project): Change[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: Change[] = [];
  for (const name of names) {
    const from = before[name] ?? null;
    const to = after[name] ?? null;
    if (from !== to) changes.push({ project: project.path, manager: project.manager, name, from, to });
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}
