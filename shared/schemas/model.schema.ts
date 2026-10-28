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

/** Alerte Dependabot ouverte, telle que la renvoie l'API GitHub, réduite à ce qui s'affiche ; `createdAt` est sa date d'émission. */
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
 * `pullRequests` les pull requests du tracker encore ouvertes à la dernière lecture.
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
 * `running` : une étape s'exécute ; `waiting_force` et `waiting_push` : l'utilisateur
 * doit décider de la suite ; les trois derniers états sont terminaux.
 */
export const OPERATION_STATUSES = ["running", "waiting_force", "waiting_push", "done", "failed", "cancelled"] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const ACTIVE_STATUSES: readonly OperationStatus[] = ["running", "waiting_force", "waiting_push"];

export const STEP_NAMES = ["clone", "audit", "fix", "force", "push"] as const;

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

/**
 * Opération d'audit ou de correction sur un clone temporaire. `workDir` est le
 * clone, présent tant que l'opération n'est pas terminée ; `pid` est le processus
 * qui exécute l'étape en cours. `found` liste les vulnérabilités du premier
 * audit, `remaining` celles qui restent après la dernière étape.
 */
export const OperationSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  kind: z.enum(OPERATION_KINDS),
  origin: z.enum(ORIGINS),
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
    force: z.enum(STEP_STATES),
    push: z.enum(STEP_STATES),
  }),
  projects: z.array(z.string()),
  counts: z.object({
    initial: z.number().int().nullable(),
    afterFix: z.number().int().nullable(),
    afterForce: z.number().int().nullable(),
  }),
  found: z.array(VulnerabilitySchema),
  remaining: z.array(VulnerabilitySchema),
  forceCandidates: z.array(ForceCandidateSchema),
  changes: z.array(ChangeSchema),
  commitMessage: z.string(),
  branch: z.string().nullable(),
  pullRequest: z.object({ number: z.number().int(), url: z.string() }).nullable(),
  error: z.string().nullable(),
  log: z.array(LogEntrySchema),
});

export type Operation = z.infer<typeof OperationSchema>;

export const DEFAULT_COMMIT_MESSAGE = "fix(deps): resolve npm audit vulnerabilities";
