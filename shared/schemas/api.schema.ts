import { z } from "zod";
import { RightsSchema, type Category, type Operation, type Repo } from "./model.schema.js";

/** Corps de `POST /api/repos` : `propriétaire/nom` ou lien GitHub, et la catégorie où le ranger (aucune par défaut). */
export const AddRepoBodySchema = z.object({
  repository: z.string().trim().min(1),
  categoryId: z.string().min(1).nullable().default(null),
});

export type AddRepoBody = z.infer<typeof AddRepoBodySchema>;

export const SetRightsBodySchema = z.object({ rights: RightsSchema });

export type SetRightsBody = z.infer<typeof SetRightsBodySchema>;

export const SetBranchBodySchema = z.object({ branch: z.string().trim().min(1) });

export type SetBranchBody = z.infer<typeof SetBranchBodySchema>;

/** Catégorie du dépôt ; null le sort de toute catégorie. */
export const SetCategoryBodySchema = z.object({ categoryId: z.string().min(1).nullable() });

export type SetCategoryBody = z.infer<typeof SetCategoryBodySchema>;

/** Corps de `POST /api/categories` et de `PUT /api/categories/:id`. */
export const CategoryBodySchema = z.object({ name: z.string().trim().min(1).max(60) });

export type CategoryBody = z.infer<typeof CategoryBodySchema>;

export const CategoryRequestSchema = z.object({ categoryId: z.string().min(1) });

/** Catégories dans l'ordre alphabétique. */
export interface CategoriesResponse {
  categories: Category[];
}

/** Branches du dépôt, la branche par défaut en tête. */
export interface BranchesResponse {
  branches: string[];
}

/** `apply` : lancer `npm audit fix --force` ; sinon l'étape est passée. */
export const ForceBodySchema = z.object({ apply: z.boolean() });

export type ForceBody = z.infer<typeof ForceBodySchema>;

export const PushBodySchema = z.object({ commitMessage: z.string().trim().min(1) });

export type PushBody = z.infer<typeof PushBodySchema>;

/** Identifiant d'un dépôt dans une requête IPC. */
export const RepoRequestSchema = z.object({ repoId: z.string().min(1) });

export const OperationRequestSchema = z.object({ operationId: z.string().min(1) });

/**
 * Dépôt, sa catégorie, et l'état de son opération en cours et de la dernière
 * opération, pour la liste et l'écran du dépôt. `cleanAuditAt` est la date du
 * dernier audit quand il n'a trouvé aucune vulnérabilité alors que Dependabot
 * signale encore des alertes émises avant lui.
 */
export interface RepoView {
  repo: Repo;
  category: Category | null;
  activeOperation: Operation | null;
  latestOperation: Operation | null;
  cleanAuditAt: string | null;
}

/** Dépôts suivis et catégories, pour l'accueil et sa barre latérale. */
export interface ReposResponse {
  repos: RepoView[];
  categories: Category[];
}

/** Dépôts accessibles au token GitHub et pas encore suivis, `propriétaire/nom`. */
export interface AddableReposResponse {
  repositories: string[];
}

export interface OperationResponse {
  operation: Operation;
}

export interface AppConfig {
  version: string;
  dataDir: string;
  githubConfigured: boolean;
}
