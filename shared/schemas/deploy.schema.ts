import { z } from "zod";

/**
 * Serveur de déploiement, tel que l'interface le voit : connexion SSH par une
 * clé ed25519 propre au tracker. `publicKey` est la clé à installer sur le
 * serveur, null quand elle a été révoquée ; `keyCreatedAt` la date de sa
 * génération ; `allowedFrom` l'adresse du tracker à laquelle sa ligne est limitée,
 * null tant qu'aucun test ne l'a posée ; `hostKeyFingerprint` l'empreinte de la
 * clé d'hôte enregistrée au premier test réussi, vérifiée à chaque connexion ;
 * `testedAt` la date du dernier test réussi.
 */
export const DeployServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  publicKey: z.string().nullable(),
  keyCreatedAt: z.string().nullable(),
  allowedFrom: z.string().nullable(),
  hostKeyFingerprint: z.string().nullable(),
  createdAt: z.string(),
  testedAt: z.string().nullable(),
});

export type DeployServer = z.infer<typeof DeployServerSchema>;

/** Serveur enregistré : la vue de l'interface et la clé privée, chiffrée avec VAULT_KEY ; null quand la clé a été révoquée. */
export const StoredDeployServerSchema = DeployServerSchema.extend({ privateKeyEncrypted: z.string().nullable() });

export type StoredDeployServer = z.infer<typeof StoredDeployServerSchema>;

export const DeployServersFileSchema = z.object({ servers: z.array(StoredDeployServerSchema) });

export type DeployServersFile = z.infer<typeof DeployServersFileSchema>;

/** Champs saisis pour un serveur. */
export const DeployServerBodySchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.coerce.number(),
  username: z.string(),
});

export type DeployServerBody = z.infer<typeof DeployServerBodySchema>;

/** `running` : le script s'exécute ; les trois autres états sont terminaux. */
export const DEPLOYMENT_STATUSES = ["running", "done", "failed", "cancelled"] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/**
 * Exécution du script de déploiement d'un dépôt sur son serveur. `script` est
 * le script tel qu'il a été lancé ; `branch` et `commit` les valeurs de
 * $BRANCH et $COMMIT ; `server` le serveur, en clair (`nom · utilisateur@hôte:port`).
 * `currentLine` est la dernière ligne du script commencée, `exitCode` le code
 * de sortie du script, `output` sa sortie, stdout et stderr fusionnés, dont seule
 * la fin est gardée au-delà de la limite (`outputTruncated`).
 */
export const DeploymentSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  serverId: z.string(),
  server: z.string(),
  branch: z.string(),
  commit: z.string().nullable(),
  script: z.string(),
  status: z.enum(DEPLOYMENT_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
  currentLine: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  output: z.string(),
  outputTruncated: z.boolean(),
  cancelRequested: z.boolean(),
  error: z.string().nullable(),
});

export type Deployment = z.infer<typeof DeploymentSchema>;

/** Ligne de la liste des déploiements : un déploiement sans son script ni sa sortie. */
export type DeploymentSummary = Omit<Deployment, "script" | "output">;

/** Corps de l'enregistrement du script d'un dépôt. */
export const SaveScriptBodySchema = z.object({ script: z.string().max(100_000) });

/** Corps du choix du serveur d'un dépôt ; null le détache. */
export const SetDeployServerBodySchema = z.object({ serverId: z.string().min(1).nullable() });

/**
 * Serveur, commande d'installation de sa clé et commande qui la retire du
 * fichier dédié, à lancer sur le serveur ; les deux sont null sans clé.
 */
export interface DeployServerView {
  server: DeployServer;
  installCommand: string | null;
  revokeCommand: string | null;
}

/** État d'une étape d'un renouvellement de clé. */
export type KeyStepStatus = "done" | "failed" | "skipped";

/** Déroulé d'un renouvellement : générer, ajouter, tester, retirer l'ancienne clé ; `error` dit pourquoi il s'est arrêté. */
export interface RotationResponse {
  server: DeployServerView;
  steps: KeyStepStatus[];
  error: string | null;
}

/** Serveurs enregistrés, du plus ancien au plus récent. */
export interface DeployServersResponse {
  servers: DeployServerView[];
}

/**
 * Déploiement d'un dépôt : son serveur (null s'il n'en a pas), son script, le
 * déploiement en cours et les derniers déploiements, du plus récent au plus ancien.
 */
export interface RepoDeployResponse {
  server: DeployServerView | null;
  script: string;
  activeDeployment: Deployment | null;
  deployments: DeploymentSummary[];
}

export interface DeploymentResponse {
  deployment: Deployment;
}

/**
 * Place de la clé sur le serveur après un test : dans le fichier dédié ou
 * non, présente aussi dans ~/.ssh/authorized_keys ou non, adresse à laquelle
 * sa ligne est limitée, et la raison pour laquelle la limite n'a pas été posée.
 */
export interface KeyFileStatus {
  inDedicatedFile: boolean;
  inAuthorizedKeys: boolean;
  allowedFrom: string | null;
  restrictError: string | null;
}

/** Résultat d'un test de connexion réussi. */
export interface TestDeployServerResponse {
  server: DeployServerView;
  fingerprint: string;
  cwd: string;
  keyFile: KeyFileStatus;
}

/** Variables que le tracker définit pour le script, avec leur rôle. */
export const SCRIPT_VARIABLES = [
  { name: "BRANCH", description: "branche suivie du dépôt" },
  { name: "COMMIT", description: "dernier commit de cette branche sur GitHub" },
  { name: "REPO", description: "dépôt, propriétaire/nom" },
] as const;
