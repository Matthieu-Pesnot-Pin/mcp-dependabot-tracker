import type { AuditScope, ManagerId, Vulnerability } from "../../../shared/schemas/model.schema.js";
import type { CommandResult } from "../commands.js";
import { runInContainer, type ContainerCommand, type ContainerRuntime, type Workspace } from "../containers.js";

/** Ce dont un gestionnaire a besoin pour lancer ses commandes dans les conteneurs d'une opération. */
export interface ManagerContext {
  runtime: ContainerRuntime;
  workspace: Workspace;
  scope: AuditScope;
  signal?: AbortSignal;
  /** Journal de l'opération. */
  log: (text: string) => void;
}

/** Image d'un conteneur : téléchargée telle quelle, ou construite à partir d'un Containerfile. */
export interface ImageSpec {
  name: string;
  containerfile?: string;
}

/** Résultat de l'audit d'un projet. */
export interface AuditResult {
  vulnerabilities: Vulnerability[];
  /** Vulnérabilités réduites à ce qui sert les corrections par Claude. */
  facts: unknown[];
}

/** Paquets installés d'un projet d'après son lockfile : version par nom (ou chemin d'installation). */
export type Lockfile = Record<string, string>;

/** Outil d'un gestionnaire, servi à Claude par le serveur MCP `packages`. */
export interface ManagerTool {
  name: string;
  description: string;
  /** Propriétés de l'outil, en plus de `project`. */
  properties: Record<string, unknown>;
  required: string[];
  /** Arguments du gestionnaire pour un appel ; lève une erreur sur un argument refusé. */
  args: (args: Record<string, unknown> | undefined, scope: AuditScope) => string[];
}

/** Gestionnaire de paquets : comment repérer ses projets, les auditer, les corriger et lire leurs lockfiles. */
export interface PackageManager {
  id: ManagerId;
  /** Lockfile suivi par git qui fait d'un dossier un projet de ce gestionnaire. */
  lockfile: string;
  /** Manifeste du projet, à côté du lockfile. */
  manifest: string;
  /** Image des conteneurs d'un projet. */
  image: (ctx: ManagerContext, project: string) => ImageSpec;
  /** Commande du conteneur qui lance le gestionnaire avec `args` dans un projet. */
  command: (ctx: ManagerContext, project: string, args: string[]) => ContainerCommand;
  audit: (ctx: ManagerContext, project: string) => Promise<AuditResult>;
  /** Corrections automatiques d'un projet vulnérable, sans installation ni script. */
  fix: (ctx: ManagerContext, project: string, vulnerabilities: Vulnerability[]) => Promise<void>;
  /** Lit le contenu d'un lockfile ; lève une erreur sur un format non pris en charge. */
  readLock: (text: string, project: string) => Lockfile;
  /** Commande des corrections automatiques, telle que la pull request la cite. */
  fixCommand: (scope: AuditScope) => string;
  tools: ManagerTool[];
  /** Consigne propre au gestionnaire, pour les corrections par Claude. */
  guide: (scope: AuditScope, server: string) => string;
}

/** Préfixe d'affichage d'un projet : `""` pour la racine, `gui/` pour le dossier `gui`. */
export function projectLabel(project: string): string {
  return project === "" ? "" : `${project}/`;
}

/** Lance le gestionnaire avec `args` dans un projet, dans un conteneur jetable, et note la commande au journal. */
export function runManager(manager: PackageManager, ctx: ManagerContext, project: string, args: string[]): Promise<CommandResult> {
  const spec = manager.command(ctx, project, args);
  ctx.log(`$ ${spec.command.join(" ")}${project ? `  (in ${project})` : ""}`);
  return runInContainer(ctx.runtime, ctx.workspace, spec, { signal: ctx.signal });
}
