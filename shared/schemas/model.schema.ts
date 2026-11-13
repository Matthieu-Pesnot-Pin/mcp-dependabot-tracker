import { z } from "zod";

/** Gravités d'une alerte Dependabot, de la plus grave à la moins grave. */
export const ALERT_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Gravités d'une vulnérabilité rapportée par `npm audit`, de la plus grave à la moins grave. */
export const NPM_SEVERITIES = ["critical", "high", "moderate", "low", "info"] as const;

export type NpmSeverity = (typeof NPM_SEVERITIES)[number];

/**
 * Périmètre d'un audit et de ses corrections : `production` laisse de côté les
 * devDependencies (`--omit=dev`), `all` couvre toutes les dépendances.
 */
export const AUDIT_SCOPES = ["production", "all"] as const;

export type AuditScope = (typeof AUDIT_SCOPES)[number];

export const DEFAULT_AUDIT_SCOPE: AuditScope = "production";

/** Portée d'une dépendance vulnérable selon Dependabot : exécution ou développement. */
export const DEPENDENCY_SCOPES = ["runtime", "development"] as const;

export type DependencyScope = (typeof DEPENDENCY_SCOPES)[number];

/**
 * Alerte Dependabot ouverte, telle que la renvoie l'API GitHub, réduite à ce qui
 * s'affiche ; `createdAt` est sa date d'émission, `scope` la portée de la
 * dépendance, null quand GitHub ne la connaît pas.
 */
export const AlertSchema = z.object({
  number: z.number().int(),
  severity: z.enum(ALERT_SEVERITIES),
  ecosystem: z.string(),
  package: z.string(),
  manifestPath: z.string(),
  summary: z.string(),
  url: z.string(),
  patchedVersion: z.string().nullable(),
  createdAt: z.string(),
  scope: z.enum(DEPENDENCY_SCOPES).nullable(),
});

export type Alert = z.infer<typeof AlertSchema>;

/**
 * Alerte que l'utilisateur a corrigée à la main alors que Dependabot la signale
 * encore. `package` est son paquet, `markedAt` la date du marquage.
 */
export const HandledAlertSchema = z.object({
  number: z.number().int(),
  package: z.string(),
  markedAt: z.string(),
});

export type HandledAlert = z.infer<typeof HandledAlertSchema>;

/** Pull request ouverte par le tracker, ni mergée ni fermée ; `branch` est sa branche `fix/npm-audit-…`. */
export const PullRequestSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  branch: z.string(),
  createdAt: z.string(),
});

export type PullRequest = z.infer<typeof PullRequestSchema>;

/** Catégorie de dépôts, choisie par l'utilisateur ; un dépôt appartient à une catégorie au plus. */
export const CategorySchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type Category = z.infer<typeof CategorySchema>;

/**
 * Dépôt suivi. `id` est le nom complet GitHub, `propriétaire/nom` ; `branch` est
 * la branche que les opérations clonent et vers laquelle la pull request est ouverte ;
 * `categoryId` est sa catégorie, null s'il n'est rangé dans aucune ;
 * `handledAlerts` les alertes qu'il a marquées corrigées à la main ;
 * `pullRequests` les pull requests du tracker encore ouvertes à la dernière lecture ;
 * `deprecatedAt` la date à laquelle il a été marqué déprécié, null sinon : un
 * dépôt déprécié n'est plus synchronisé ni audité ;
 * `queuedAt` la date de son entrée dans la file d'attente, null s'il n'y est pas ;
 * `deployPendingAt` la date à laquelle il a été marqué « à déployer », null s'il ne l'est pas ;
 * `deployServerId` le serveur sur lequel il se déploie, null s'il n'en a pas ;
 * `deployScript` le script shell qui le déploie sur ce serveur.
 */
export const RepoSchema = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  branch: z.string(),
  categoryId: z.string().nullable(),
  addedAt: z.string(),
  alerts: z.array(AlertSchema),
  handledAlerts: z.array(HandledAlertSchema),
  pullRequests: z.array(PullRequestSchema),
  syncedAt: z.string().nullable(),
  syncError: z.string().nullable(),
  deprecatedAt: z.string().nullable(),
  queuedAt: z.string().nullable(),
  deployPendingAt: z.string().nullable(),
  deployServerId: z.string().nullable(),
  deployScript: z.string(),
});

export type Repo = z.infer<typeof RepoSchema>;

export const ReposFileSchema = z.object({ categories: z.array(CategorySchema), repos: z.array(RepoSchema) });

export type ReposFile = z.infer<typeof ReposFileSchema>;

/** `audit` : clone et `npm audit` seulement ; `fix` : jusqu'aux corrections, à la branche et à la PR. */
export const OPERATION_KINDS = ["audit", "fix"] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

/** Qui a lancé l'opération : l'utilisateur depuis la GUI, ou un agent par le mode MCP. */
export const ORIGINS = ["user", "agent"] as const;

export type Origin = (typeof ORIGINS)[number];

/** `running` : l'opération s'exécute ; les trois autres états sont terminaux. */
export const OPERATION_STATUSES = ["running", "done", "failed", "cancelled"] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const ACTIVE_STATUSES: readonly OperationStatus[] = ["running"];

export const STEP_NAMES = ["clone", "audit", "fix", "repair", "push"] as const;

export type StepName = (typeof STEP_NAMES)[number];

export const STEP_STATES = ["pending", "running", "done", "skipped", "failed"] as const;

export type StepState = (typeof STEP_STATES)[number];

/** Correction proposée par `npm audit` : aucune, dans les plages déclarées, ou par une version majeure. */
export const FIX_KINDS = ["none", "available", "major"] as const;

export type FixKind = (typeof FIX_KINDS)[number];

/** Vulnérabilité d'un projet npm du dépôt ; `project` est le dossier du lockfile, `""` pour la racine. */
export const VulnerabilitySchema = z.object({
  project: z.string(),
  name: z.string(),
  severity: z.enum(NPM_SEVERITIES),
  fix: z.enum(FIX_KINDS),
});

export type Vulnerability = z.infer<typeof VulnerabilitySchema>;

/** Paquet du lockfile dont la version a changé ; `from` null pour un ajout, `to` null pour un retrait. */
export const ChangeSchema = z.object({
  project: z.string(),
  name: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});

export type Change = z.infer<typeof ChangeSchema>;

export const LogEntrySchema = z.object({ at: z.string(), text: z.string() });

export type LogEntry = z.infer<typeof LogEntrySchema>;

/** Résultat des tests lancés par Claude après ses corrections. */
export const TEST_OUTCOMES = ["passed", "failed", "not_run"] as const;

/**
 * Rapport rendu par Claude à la fin de ses corrections : résumé, changement de
 * chaque fichier, message du commit et résultat des tests.
 */
export const RepairReportSchema = z.object({
  summary: z.string(),
  changes: z.array(z.object({ file: z.string(), change: z.string() })),
  commitMessage: z.string(),
  tests: z.object({ outcome: z.enum(TEST_OUTCOMES), detail: z.string() }),
});

export type RepairReport = z.infer<typeof RepairReportSchema>;

/** Statuts d'une tâche de l'organizer. */
export const TASK_STATUSES = ["todo", "doing", "review", "done"] as const;

/** Tâche de l'organizer ; `url` ouvre la tâche sur le site, `status` est relu à chaque synchronisation. */
export const OrganizerTaskSchema = z.object({
  key: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(TASK_STATUSES),
});

export type OrganizerTask = z.infer<typeof OrganizerTaskSchema>;

/** Élément du déroulé d'une session de Claude : message (`text`) ou appel d'outil en clair (`tool`). */
export const SessionEventSchema = z.object({ kind: z.enum(["text", "tool"]), text: z.string() });

export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * Corrections par Claude des vulnérabilités que `npm audit fix` laisse, en une
 * session qui les analyse, les corrige et en rend compte dans une tâche de
 * l'organizer. `base` est le commit sur lequel repose celui de Claude : le
 * commit de `npm audit fix` (`auditCommit`), ou le commit cloné quand
 * `npm audit fix` n'a rien changé et que `auditCommit` est null. `commit` est
 * le commit de Claude, null quand il n'a rien modifié ; `task` la tâche du
 * rapport. `turns`, `activity` (dernières actions) et `events` (déroulé
 * complet) suivent la session ; `error` est la raison de son échec.
 */
export const RepairSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  turns: z.number().int(),
  activity: z.array(z.string()),
  events: z.array(SessionEventSchema),
  base: z.string(),
  auditCommit: z.string().nullable(),
  commit: z.string().nullable(),
  report: RepairReportSchema.nullable(),
  task: OrganizerTaskSchema.nullable(),
  error: z.string().nullable(),
});

export type Repair = z.infer<typeof RepairSchema>;

/**
 * Opération d'audit ou de correction sur un clone temporaire, limitée aux
 * dépendances de `scope`. `workDir` est le
 * clone, présent tant que l'opération n'est pas terminée. `found` liste les vulnérabilités du premier
 * audit, `remaining` celles qui restent après la dernière étape. `repair` est
 * la session de corrections par Claude, null quand elle n'a pas été lancée.
 */
export const OperationSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  kind: z.enum(OPERATION_KINDS),
  origin: z.enum(ORIGINS),
  scope: z.enum(AUDIT_SCOPES),
  status: z.enum(OPERATION_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
  workDir: z.string().nullable(),
  baseBranch: z.string(),
  cancelRequested: z.boolean(),
  steps: z.object({
    clone: z.enum(STEP_STATES),
    audit: z.enum(STEP_STATES),
    fix: z.enum(STEP_STATES),
    repair: z.enum(STEP_STATES),
    push: z.enum(STEP_STATES),
  }),
  projects: z.array(z.string()),
  counts: z.object({
    initial: z.number().int().nullable(),
    afterFix: z.number().int().nullable(),
    afterRepair: z.number().int().nullable(),
  }),
  found: z.array(VulnerabilitySchema),
  remaining: z.array(VulnerabilitySchema),
  changes: z.array(ChangeSchema),
  commitMessage: z.string(),
  branch: z.string().nullable(),
  pullRequest: z.object({ number: z.number().int(), url: z.string() }).nullable(),
  repair: RepairSchema.nullable(),
  error: z.string().nullable(),
  log: z.array(LogEntrySchema),
});

export type Operation = z.infer<typeof OperationSchema>;

export const DEFAULT_COMMIT_MESSAGE = "fix(deps): resolve npm audit vulnerabilities";
