import { z } from "zod";
import { AUDIT_SCOPES, RightsSchema, type AlertSeverity, type AnalysisTask, type AuditScope, type Category, type Operation, type Remark, type Repo } from "./model.schema.js";

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

/** Corps de `POST /api/repos/:owner/:name/operations` : le périmètre de l'audit. */
export const ScopeBodySchema = z.object({ scope: z.enum(AUDIT_SCOPES) });

export type ScopeBody = z.infer<typeof ScopeBodySchema>;

/** Dépôts visés par « Auditer tout » : tous les dépôts suivis, ceux d'une catégorie, ou ceux de la file d'attente. */
export const AuditTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("category"), categoryId: z.string().min(1) }),
  z.object({ kind: z.literal("queue") }),
]);

export type AuditTarget = z.infer<typeof AuditTargetSchema>;

/** Corps de `POST /api/audit-all` : le périmètre des audits et les dépôts visés. */
export const AuditAllBodySchema = ScopeBodySchema.extend({ target: AuditTargetSchema });

export type AuditAllBody = z.infer<typeof AuditAllBodySchema>;

/** `apply` : lancer `npm audit fix --force` ; sinon l'étape est passée. */
export const ForceBodySchema = z.object({ apply: z.boolean() });

export type ForceBody = z.infer<typeof ForceBodySchema>;

/** `run` : lancer ou relancer les corrections par Claude ; sinon l'étape est passée. */
export const RepairBodySchema = z.object({ run: z.boolean() });

export type RepairBody = z.infer<typeof RepairBodySchema>;

export const PushBodySchema = z.object({ commitMessage: z.string().trim().min(1) });

export type PushBody = z.infer<typeof PushBodySchema>;

/** Identifiant d'un dépôt dans une requête IPC. */
export const RepoRequestSchema = z.object({ repoId: z.string().min(1) });

/** Alerte d'un dépôt, par son numéro GitHub. */
export const AlertRequestSchema = z.object({ repoId: z.string().min(1), number: z.coerce.number().int().positive() });

export const OperationRequestSchema = z.object({ operationId: z.string().min(1) });

/** Vulnérabilités trouvées par un audit : leur nombre, la plus haute gravité, la date et le périmètre de l'audit. */
export interface AuditFindings {
  at: string;
  scope: AuditScope;
  count: number;
  severity: AlertSeverity;
}

/** Audit qui n'a trouvé aucune vulnérabilité : sa date et son périmètre. */
export interface CleanAudit {
  at: string;
  scope: AuditScope;
}

/**
 * Dépôt, sa catégorie, et l'état de son opération en cours et de la dernière
 * opération, pour la liste et l'écran du dépôt. `cleanAudit` est le dernier
 * audit quand il n'a trouvé aucune vulnérabilité alors que Dependabot signale
 * encore, dans son périmètre, des alertes émises avant lui ; `auditFindings` ce
 * qu'a trouvé le dernier audit de la branche par défaut alors que Dependabot ne
 * signale aucune alerte dans son périmètre ; `unfixable` les paquets pour lesquels le dernier audit n'a
 * trouvé aucune version corrigée, hors ceux marqués corrigés à la main ;
 * `analysisTask` la tâche organizer de la dernière analyse par Claude, tant
 * qu'elle n'est pas terminée.
 */
export interface RepoView {
  repo: Repo;
  category: Category | null;
  activeOperation: Operation | null;
  latestOperation: Operation | null;
  cleanAudit: CleanAudit | null;
  auditFindings: AuditFindings | null;
  unfixable: string[];
  analysisTask: AnalysisTask | null;
}

/**
 * Série « Auditer tout » : `done` dépôts traités sur `total`, dont ceux laissés
 * de côté parce qu'une opération y était en cours (`skipped`) et ceux dont
 * l'audit a échoué, avec la raison (`failed`) ; `scope` est le périmètre des
 * audits, `target` les dépôts visés.
 */
export interface AuditAllState {
  running: boolean;
  scope: AuditScope;
  target: AuditTarget;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  done: number;
  skipped: string[];
  failed: { repoId: string; error: string }[];
}

/** Dernière série « Auditer tout », null si aucune n'a été lancée depuis le démarrage du serveur. */
export interface AuditAllResponse {
  auditAll: AuditAllState | null;
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

/**
 * Ligne de l'historique d'un dépôt : une opération sans son journal ni le
 * déroulé de ses sessions. `after` est le nombre de vulnérabilités après la
 * dernière étape qui a audité ; `claudeRuns` le nombre de passages des
 * corrections par Claude.
 */
export interface OperationSummary {
  id: string;
  kind: Operation["kind"];
  origin: Operation["origin"];
  scope: AuditScope;
  status: Operation["status"];
  baseBranch: string;
  createdAt: string;
  before: number | null;
  after: number | null;
  analysed: boolean;
  claudeRuns: number;
  pullRequest: Operation["pullRequest"];
  error: string | null;
}

/** Historique d'un dépôt, de l'opération la plus récente à la plus ancienne. */
export interface OperationsResponse {
  operations: OperationSummary[];
}

/** Tâche de l'analyse d'une opération et ses commentaires récents, du plus ancien au plus récent. */
export interface RemarksResponse {
  task: AnalysisTask;
  remarks: Remark[];
}

export interface AppConfig {
  version: string;
  dataDir: string;
  githubConfigured: boolean;
}
