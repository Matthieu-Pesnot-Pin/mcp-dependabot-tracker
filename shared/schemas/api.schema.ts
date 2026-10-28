import { z } from "zod";
import { RightsSchema, type Operation, type Repo } from "./model.schema.js";

/** Corps de `POST /api/repos` : `propriétaire/nom` ou lien GitHub. */
export const AddRepoBodySchema = z.object({ repository: z.string().trim().min(1) });

export type AddRepoBody = z.infer<typeof AddRepoBodySchema>;

export const SetRightsBodySchema = z.object({ rights: RightsSchema });

export type SetRightsBody = z.infer<typeof SetRightsBodySchema>;

export const SetBranchBodySchema = z.object({ branch: z.string().trim().min(1) });

export type SetBranchBody = z.infer<typeof SetBranchBodySchema>;

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

/** Dépôt et état de son opération en cours et de la dernière opération, pour la liste et l'écran du dépôt. */
export interface RepoView {
  repo: Repo;
  activeOperation: Operation | null;
  latestOperation: Operation | null;
}

export interface ReposResponse {
  repos: RepoView[];
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
