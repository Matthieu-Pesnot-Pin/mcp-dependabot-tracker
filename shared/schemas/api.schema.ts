import { z } from "zod";
import { AUDIT_SCOPES, type AlertSeverity, type AuditScope, type Category, type Operation, type OrganizerTask, type Repo } from "./model.schema.js";

/** Corps de `POST /api/repos` : `propriétaire/nom` ou lien GitHub, et la catégorie où le ranger (aucune par défaut). */
export const AddRepoBodySchema = z.object({
  repository: z.string().trim().min(1),
  categoryId: z.string().min(1).nullable().default(null),
});

export type AddRepoBody = z.infer<typeof AddRepoBodySchema>;

export const SetBranchBodySchema = z.object({ branch: z.string().trim().min(1) });

export type SetBranchBody = z.infer<typeof SetBranchBodySchema>;

/** Catégorie du dépôt ; null le sort de toute catégorie. */
export const SetCategoryBodySchema = z.object({ categoryId: z.string().min(1).nullable() });

export type SetCategoryBody = z.infer<typeof SetCategoryBodySchema>;

/** Corps de `POST /api/categories` et de `PUT /api/categories/:id`. */
export const CategoryBodySchema = z.object({ name: z.string().trim().min(1).max(60) });

export type CategoryBody = z.infer<typeof CategoryBodySchema>;

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

/** `deploy` : le dépôt passe aussi « à déployer », son déploiement n'étant pas automatique. */
export const MergedBodySchema = z.object({ deploy: z.boolean() });

export type MergedBody = z.infer<typeof MergedBodySchema>;

/** Numéro GitHub d'une alerte, porté par le chemin de la requête. */
export const AlertNumberSchema = z.coerce.number().int().positive();

/**
 * Corps de `POST /api/agent/repos/:owner/:name/fixes` : le périmètre, et les
 * corrections par Claude quand `npm audit fix` laisse des vulnérabilités.
 */
export const AgentFixBodySchema = ScopeBodySchema.extend({ claude: z.boolean() });

export type AgentFixBody = z.infer<typeof AgentFixBodySchema>;

/** Dépôts non dépréciés renvoyés à un agent : tous, ou ceux de `category` quand il en a demandé une. */
export interface AgentReposResponse {
  repos: RepoView[];
  category: Category | null;
}

/** Opération renvoyée à un agent, avec l'adresse de son écran dans la GUI. */
export interface AgentOperationResponse {
  operation: Operation;
  guiUrl: string;
}

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
 * Dernier audit d'un dépôt, quelle que soit sa branche : sa date, son
 * périmètre, la branche auditée, le nombre de vulnérabilités et la plus haute
 * gravité, null sans vulnérabilité. `afterFix` : audit qui suit les corrections
 * d'une opération, sur la branche de sa pull request.
 */
export interface LastAudit {
  at: string;
  scope: AuditScope;
  branch: string;
  afterFix: boolean;
  count: number;
  severity: AlertSeverity | null;
}

/**
 * Dépôt, sa catégorie, et l'état de son opération en cours et de la dernière
 * opération, pour la liste et l'écran du dépôt. `lastAudit` résume le dernier
 * audit, quelle que soit sa branche. `cleanAudit` est le dernier
 * audit quand il n'a trouvé aucune vulnérabilité alors que Dependabot signale
 * encore, dans son périmètre, des alertes émises avant lui ;
 * `cleanProductionAudit` le dernier audit, de production, de la branche par
 * défaut, quand il n'a trouvé aucune vulnérabilité et que toutes les alertes
 * ouvertes portent sur des dépendances de développement ; `auditFindings` ce
 * qu'a trouvé le dernier audit de la branche par défaut alors que Dependabot ne
 * signale aucune alerte dans son périmètre ; `unfixable` les paquets pour lesquels le dernier audit n'a
 * trouvé aucune version corrigée, hors ceux marqués corrigés à la main ;
 * `reportTask` la tâche organizer du dernier rapport de Claude, tant qu'elle
 * n'est pas terminée.
 */
export interface RepoView {
  repo: Repo;
  category: Category | null;
  activeOperation: Operation | null;
  latestOperation: Operation | null;
  lastAudit: LastAudit | null;
  cleanAudit: CleanAudit | null;
  cleanProductionAudit: CleanAudit | null;
  auditFindings: AuditFindings | null;
  unfixable: string[];
  reportTask: OrganizerTask | null;
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
 * dernière étape qui a audité ; `claude` est vrai quand Claude a été lancé
 * pour corriger.
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
  claude: boolean;
  pullRequest: Operation["pullRequest"];
  error: string | null;
}

/** Historique d'un dépôt, de l'opération la plus récente à la plus ancienne. */
export interface OperationsResponse {
  operations: OperationSummary[];
}

/** Configuration lue par la GUI ; `githubServerUrl` est l'adresse web du serveur GitHub, sans barre finale. */
export interface AppConfig {
  version: string;
  dataDir: string;
  githubServerUrl: string;
}
