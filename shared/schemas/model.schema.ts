import { z } from "zod";

/** Gravités d'une alerte Dependabot, de la plus grave à la moins grave. */
export const ALERT_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Gravités d'une vulnérabilité rapportée par `npm audit`, de la plus grave à la moins grave. */
export const NPM_SEVERITIES = ["critical", "high", "moderate", "low", "info"] as const;

export type NpmSeverity = (typeof NPM_SEVERITIES)[number];

/** Actions que l'agent peut être autorisé à lancer sur un dépôt, par les outils MCP. */
export const RIGHTS = ["audit", "fix", "force", "push"] as const;

export type Right = (typeof RIGHTS)[number];

export const RightsSchema = z.object({
  audit: z.boolean(),
  fix: z.boolean(),
  force: z.boolean(),
  push: z.boolean(),
});

export type Rights = z.infer<typeof RightsSchema>;

/** Droits d'un dépôt qui vient d'être ajouté : l'audit seul. */
export const DEFAULT_RIGHTS: Rights = { audit: true, fix: false, force: false, push: false };

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
 * `deployPendingAt` la date à laquelle il a été marqué « à déployer », null s'il ne l'est pas.
 */
export const RepoSchema = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  branch: z.string(),
  categoryId: z.string().nullable(),
  addedAt: z.string(),
  rights: RightsSchema,
  alerts: z.array(AlertSchema),
  handledAlerts: z.array(HandledAlertSchema),
  pullRequests: z.array(PullRequestSchema),
  syncedAt: z.string().nullable(),
  syncError: z.string().nullable(),
  deprecatedAt: z.string().nullable(),
  queuedAt: z.string().nullable(),
  deployPendingAt: z.string().nullable(),
});

export type Repo = z.infer<typeof RepoSchema>;

export const ReposFileSchema = z.object({ categories: z.array(CategorySchema), repos: z.array(RepoSchema) });

export type ReposFile = z.infer<typeof ReposFileSchema>;

/** `audit` : clone et `npm audit` seulement ; `fix` : jusqu'aux corrections, à la branche et à la PR. */
export const OPERATION_KINDS = ["audit", "fix"] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

/** Qui a lancé l'opération : l'utilisateur depuis la GUI, ou l'agent par un outil MCP. */
export const ORIGINS = ["user", "agent"] as const;

export type Origin = (typeof ORIGINS)[number];

/**
 * `running` : une étape s'exécute ; `waiting_force`, `waiting_repair` et
 * `waiting_push` : l'utilisateur doit décider de la suite ; les trois derniers
 * états sont terminaux.
 */
export const OPERATION_STATUSES = ["running", "waiting_force", "waiting_repair", "waiting_push", "done", "failed", "cancelled"] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const ACTIVE_STATUSES: readonly OperationStatus[] = ["running", "waiting_force", "waiting_repair", "waiting_push"];

export const STEP_NAMES = ["clone", "audit", "fix", "analysis", "force", "repair", "push"] as const;

export type StepName = (typeof STEP_NAMES)[number];

export const STEP_STATES = ["pending", "running", "done", "skipped", "failed"] as const;

export type StepState = (typeof STEP_STATES)[number];

/** Correction proposée par `npm audit` : aucune, dans les plages déclarées, ou par une version majeure (`--force`). */
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

/** Paquet que `npm audit fix --force` monterait d'une version majeure, et le nombre de vulnérabilités que cela corrige. */
export const ForceCandidateSchema = z.object({
  project: z.string(),
  name: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  vulnerabilities: z.number().int(),
});

export type ForceCandidate = z.infer<typeof ForceCandidateSchema>;

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

/** Rapport rendu par Claude à la fin d'une analyse : résumé, corrections urgentes à la main, avis sur `--force`. */
export const AnalysisReportSchema = z.object({
  summary: z.string(),
  urgent: z.array(z.object({ package: z.string(), reason: z.string() })),
  force: z.object({ recommended: z.boolean(), reason: z.string() }),
});

export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;

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

/** Tâche créée dans l'organizer par une analyse ; `url` ouvre la tâche sur le site, `status` est relu à chaque synchronisation. */
export const AnalysisTaskSchema = z.object({
  key: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(TASK_STATUSES),
});

export type AnalysisTask = z.infer<typeof AnalysisTaskSchema>;

/**
 * Analyse par Claude des vulnérabilités restantes après `npm audit fix`.
 * `turns` et `activity` (dernières actions de Claude) suivent la session en
 * cours ; `report` et `task` sont remplis à la fin, `error` en cas d'échec.
 */
export const AnalysisSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  turns: z.number().int(),
  activity: z.array(z.string()),
  report: AnalysisReportSchema.nullable(),
  task: AnalysisTaskSchema.nullable(),
  error: z.string().nullable(),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

/**
 * Corrections par Claude, d'après la tâche de l'analyse et les commentaires de
 * l'utilisateur. `base` est le commit sur lequel repose celui de Claude : le
 * commit de `npm audit fix` (`auditCommit`), ou le commit cloné quand
 * `npm audit fix` n'a rien changé et que `auditCommit` est null.
 * `commit` est le commit de Claude, null tant qu'il n'a rien modifié ; `task`
 * la sous-tâche « rapport de développement ». `turns` et `activity` suivent la
 * session en cours ; `error` est la raison de l'échec du dernier passage, les
 * résultats du passage précédent restant valables.
 */
export const RepairSchema = z.object({
  runs: z.number().int(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  turns: z.number().int(),
  activity: z.array(z.string()),
  base: z.string(),
  auditCommit: z.string().nullable(),
  commit: z.string().nullable(),
  report: RepairReportSchema.nullable(),
  task: AnalysisTaskSchema.nullable(),
  error: z.string().nullable(),
});

export type Repair = z.infer<typeof RepairSchema>;

/** Commentaire d'une tâche organizer : son auteur, son texte et sa date. */
export const RemarkSchema = z.object({ author: z.string(), body: z.string(), createdAt: z.string() });

export type Remark = z.infer<typeof RemarkSchema>;

export const SESSION_KINDS = ["analysis", "repair"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const SESSION_OUTCOMES = ["running", "done", "failed", "cancelled"] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

/** Ce qu'une session a fait d'une tâche organizer : relue, créée ou mise à jour. */
export const SESSION_TASK_ROLES = ["read", "created", "updated"] as const;
export type SessionTaskRole = (typeof SESSION_TASK_ROLES)[number];

/** Élément du déroulé d'une session : message de Claude (`text`) ou appel d'outil en clair (`tool`). */
export const SessionEventSchema = z.object({ kind: z.enum(["text", "tool"]), text: z.string() });

export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * Session de Claude d'une opération, gardée pour l'historique : l'analyse, ou
 * un passage des corrections (`run`, 1 pour l'analyse). `remarks` sont les
 * commentaires de la tâche de l'analyse au lancement des corrections, `tasks`
 * les tâches organizer relues, créées ou mises à jour, `events` le déroulé de
 * la session. Le résultat est le rapport de l'analyse, ou celui des
 * corrections avec leur commit et les vulnérabilités restantes.
 */
export const ClaudeSessionSchema = z.object({
  kind: z.enum(SESSION_KINDS),
  run: z.number().int(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  turns: z.number().int(),
  outcome: z.enum(SESSION_OUTCOMES),
  error: z.string().nullable(),
  remarks: z.array(RemarkSchema),
  tasks: z.array(z.object({ task: AnalysisTaskSchema, role: z.enum(SESSION_TASK_ROLES) })),
  events: z.array(SessionEventSchema),
  analysisReport: AnalysisReportSchema.nullable(),
  repairReport: RepairReportSchema.nullable(),
  commit: z.string().nullable(),
  remaining: z.number().int().nullable(),
});

export type ClaudeSession = z.infer<typeof ClaudeSessionSchema>;

/**
 * Opération d'audit ou de correction sur un clone temporaire, limitée aux
 * dépendances de `scope`. `workDir` est le
 * clone, présent tant que l'opération n'est pas terminée ; `pid` est le processus
 * qui exécute l'étape en cours. `found` liste les vulnérabilités du premier
 * audit, `remaining` celles qui restent après la dernière étape. `analysis` est
 * l'analyse par Claude, null quand elle n'a pas été lancée ; `repair` ses
 * corrections, null tant qu'elles n'ont pas été lancées ; `sessions` chaque
 * session de Claude, dans l'ordre.
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
  pid: z.number().int(),
  workDir: z.string().nullable(),
  baseBranch: z.string(),
  cancelRequested: z.boolean(),
  steps: z.object({
    clone: z.enum(STEP_STATES),
    audit: z.enum(STEP_STATES),
    fix: z.enum(STEP_STATES),
    analysis: z.enum(STEP_STATES),
    force: z.enum(STEP_STATES),
    repair: z.enum(STEP_STATES),
    push: z.enum(STEP_STATES),
  }),
  projects: z.array(z.string()),
  counts: z.object({
    initial: z.number().int().nullable(),
    afterFix: z.number().int().nullable(),
    afterForce: z.number().int().nullable(),
    afterRepair: z.number().int().nullable(),
  }),
  found: z.array(VulnerabilitySchema),
  remaining: z.array(VulnerabilitySchema),
  forceCandidates: z.array(ForceCandidateSchema),
  changes: z.array(ChangeSchema),
  commitMessage: z.string(),
  branch: z.string().nullable(),
  pullRequest: z.object({ number: z.number().int(), url: z.string() }).nullable(),
  analysis: AnalysisSchema.nullable(),
  repair: RepairSchema.nullable(),
  sessions: z.array(ClaudeSessionSchema),
  error: z.string().nullable(),
  log: z.array(LogEntrySchema),
});

export type Operation = z.infer<typeof OperationSchema>;

export const DEFAULT_COMMIT_MESSAGE = "fix(deps): resolve npm audit vulnerabilities";
