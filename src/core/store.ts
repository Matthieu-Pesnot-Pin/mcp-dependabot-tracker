import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  ACTIVE_STATUSES,
  OperationSchema,
  ReposFileSchema,
  type Category,
  type Operation,
  type Repo,
  type ReposFile,
} from "../../shared/schemas/model.schema.js";
import { ConflictError, NotFoundError, TrackerError } from "./errors.js";

/** Opérations terminées conservées par dépôt ; les plus anciennes sont supprimées. */
const KEPT_OPERATIONS_PER_REPO = 20;

const OPERATION_ID_PATTERN = /^[a-z0-9-]+$/;

/** Écriture atomique : fichier temporaire unique puis `rename`, JSON indenté. */
function writeJsonAtomic(target: string, value: unknown): void {
  const tmp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Complète un fichier écrit par une version antérieure : un dépôt sans branche
 * choisie analyse sa branche par défaut, un dépôt sans catégorie n'est rangé
 * dans aucune, un fichier sans catégories n'en a aucune, un dépôt sans alerte
 * corrigée à la main n'en a aucune, un dépôt sans pull request en attente n'en
 * a aucune jusqu'à sa lecture suivante, un dépôt sans date de dépréciation
 * n'est pas déprécié, un dépôt sans date d'entrée dans la file n'y est pas, un
dépôt sans date de marque « à déployer » ne l'est pas. Une alerte sans date
 * d'émission prend celle de la lecture qui l'a rapportée, une alerte sans
 * portée n'en a aucune ; la lecture suivante les remplace par les vraies.
 */
function normalizeReposFile(file: any): unknown {
  if (!Array.isArray(file?.repos)) return file;
  return {
    ...file,
    categories: file.categories ?? [],
    repos: file.repos.map((repo: any) => ({
      ...repo,
      branch: typeof repo?.branch === "string" ? repo.branch : repo?.defaultBranch,
      categoryId: repo?.categoryId ?? null,
      handledAlerts: repo?.handledAlerts ?? [],
      pullRequests: repo?.pullRequests ?? [],
      deprecatedAt: repo?.deprecatedAt ?? null,
      queuedAt: repo?.queuedAt ?? null,
      deployPendingAt: repo?.deployPendingAt ?? null,
      alerts: Array.isArray(repo?.alerts)
        ? repo.alerts.map((alert: any) => ({ ...alert, createdAt: alert?.createdAt ?? repo.syncedAt ?? repo.addedAt, scope: alert?.scope ?? null }))
        : repo?.alerts,
    })),
  };
}

/** Statuts d'attente d'une version antérieure, où l'opération attendait une décision de l'utilisateur. */
const FORMER_WAITING_STATUSES = ["waiting_force", "waiting_repair", "waiting_push"];

/**
 * Complète une opération écrite par une version antérieure : sans `found`, les
 * vulnérabilités du premier audit sont `remaining` tant qu'aucune correction
 * n'a suivi, et inconnues sinon ; sans étape de corrections par Claude,
 * l'étape est passée ; sans périmètre, l'audit a couvert toutes les
 * dépendances. Une opération qui attendait une décision de l'utilisateur est
 * annulée ; des corrections par Claude sans déroulé en ont un vide.
 */
function normalizeOperation(operation: any): unknown {
  if (operation === null || typeof operation !== "object") return operation;
  return {
    ...operation,
    status: FORMER_WAITING_STATUSES.includes(operation.status) ? "cancelled" : operation.status,
    found: operation.found ?? (operation.counts?.afterFix === null ? operation.remaining : []),
    steps: operation.steps && typeof operation.steps === "object" ? { repair: "skipped", ...operation.steps } : operation.steps,
    counts: operation.counts && typeof operation.counts === "object" ? { afterRepair: null, ...operation.counts } : operation.counts,
    repair: operation.repair ? { events: [], ...operation.repair } : null,
    scope: operation.scope ?? "all",
  };
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function findCategoryIn(file: ReposFile, categoryId: string): Category {
  const category = file.categories.find((candidate) => candidate.id === categoryId);
  if (!category) throw new NotFoundError(`Category "${categoryId}" does not exist.`);
  return category;
}

function assertNameFree(file: ReposFile, name: string, exceptId: string | null): void {
  const taken = file.categories.find((category) => category.id !== exceptId && sameName(category.name, name));
  if (taken) throw new ConflictError(`A category named "${taken.name}" already exists.`);
}

export function isActive(operation: Operation): boolean {
  return ACTIVE_STATUSES.includes(operation.status);
}

/** Refuse toute lecture GitHub ou opération sur un dépôt déprécié. */
export function assertNotDeprecated(repo: Repo): void {
  if (repo.deprecatedAt !== null) {
    throw new ConflictError(`Repository ${repo.id} is deprecated: it is neither synced nor audited. Only the user can restore it, in the GUI.`);
  }
}

/**
 * Persistance : `<dataDir>/repos.json` pour les dépôts suivis et
 * `<dataDir>/operations/<id>.json` pour chaque opération. Le serveur est le
 * seul processus qui les écrit ; chaque écriture est atomique.
 */
export class Store {
  readonly dataDir: string;
  private readonly reposPath: string;
  private readonly operationsDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.reposPath = path.join(dataDir, "repos.json");
    this.operationsDir = path.join(dataDir, "operations");
    fs.mkdirSync(this.operationsDir, { recursive: true });
  }

  // --- Dépôts et catégories ----------------------------------------------------

  private readReposFile(): ReposFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.reposPath, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") return { categories: [], repos: [] };
      throw err;
    }
    const parsed = ReposFileSchema.safeParse(normalizeReposFile(JSON.parse(raw)));
    if (!parsed.success) throw new TrackerError(`${this.reposPath} is invalid: ${parsed.error.message}`);
    return parsed.data;
  }

  private writeReposFile(file: ReposFile): void {
    writeJsonAtomic(this.reposPath, ReposFileSchema.parse(file));
  }

  listRepos(): Repo[] {
    return this.readReposFile().repos;
  }

  /** Dépôt d'identifiant `propriétaire/nom`, sans tenir compte de la casse, comme GitHub. */
  findRepo(repoId: string): Repo | null {
    const key = repoId.toLowerCase();
    return this.listRepos().find((repo) => repo.id.toLowerCase() === key) ?? null;
  }

  getRepo(repoId: string): Repo {
    const repo = this.findRepo(repoId);
    if (!repo) throw new NotFoundError(`Repository "${repoId}" is not tracked. Use list_repositories to see the tracked repositories.`);
    return repo;
  }

  /** Ajoute un dépôt ; sa catégorie, s'il en a une, doit exister. */
  addRepo(repo: Repo): Repo {
    const file = this.readReposFile();
    if (file.repos.some((existing) => existing.id.toLowerCase() === repo.id.toLowerCase())) {
      throw new ConflictError(`Repository ${repo.id} is already tracked.`);
    }
    if (repo.categoryId !== null) findCategoryIn(file, repo.categoryId);
    this.writeReposFile({ ...file, repos: [...file.repos, repo] });
    return repo;
  }

  /** Modifie un dépôt ; une catégorie qui lui est attribuée doit exister. */
  updateRepo(repoId: string, fn: (repo: Repo) => Repo): Repo {
    const file = this.readReposFile();
    const index = file.repos.findIndex((repo) => repo.id.toLowerCase() === repoId.toLowerCase());
    if (index === -1) throw new NotFoundError(`Repository "${repoId}" is not tracked.`);
    const updated = fn(file.repos[index]);
    if (updated.categoryId !== null) findCategoryIn(file, updated.categoryId);
    const repos = [...file.repos];
    repos[index] = updated;
    this.writeReposFile({ ...file, repos });
    return updated;
  }

  /** Retire un dépôt et ses opérations ; refusé pendant une opération en cours. */
  removeRepo(repoId: string): void {
    const file = this.readReposFile();
    const repo = file.repos.find((candidate) => candidate.id.toLowerCase() === repoId.toLowerCase());
    if (!repo) throw new NotFoundError(`Repository "${repoId}" is not tracked.`);
    const operations = this.readOperationsOf(repo.id);
    if (operations.some(isActive)) throw new ConflictError(`An operation is in progress on ${repo.id}: cancel it before removing the repository.`);
    for (const operation of operations) fs.rmSync(this.operationPath(operation.id), { force: true });
    this.writeReposFile({ ...file, repos: file.repos.filter((candidate) => candidate !== repo) });
  }

  /** Catégories dans l'ordre alphabétique. */
  listCategories(): Category[] {
    return [...this.readReposFile().categories].sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
  }

  getCategory(categoryId: string): Category {
    return findCategoryIn(this.readReposFile(), categoryId);
  }

  /** Crée une catégorie ; deux catégories ne portent pas le même nom, sans tenir compte de la casse. */
  createCategory(name: string): Category {
    const file = this.readReposFile();
    assertNameFree(file, name, null);
    const category = { id: crypto.randomBytes(6).toString("hex"), name: name.trim() };
    this.writeReposFile({ ...file, categories: [...file.categories, category] });
    return category;
  }

  renameCategory(categoryId: string, name: string): Category {
    const file = this.readReposFile();
    findCategoryIn(file, categoryId);
    assertNameFree(file, name, categoryId);
    const renamed = { id: categoryId, name: name.trim() };
    this.writeReposFile({ ...file, categories: file.categories.map((category) => (category.id === categoryId ? renamed : category)) });
    return renamed;
  }

  /** Supprime une catégorie ; ses dépôts restent suivis, sans catégorie. */
  deleteCategory(categoryId: string): void {
    const file = this.readReposFile();
    findCategoryIn(file, categoryId);
    this.writeReposFile({
      categories: file.categories.filter((category) => category.id !== categoryId),
      repos: file.repos.map((repo) => (repo.categoryId === categoryId ? { ...repo, categoryId: null } : repo)),
    });
  }

  // --- Opérations ---------------------------------------------------------------

  private operationPath(id: string): string {
    if (!OPERATION_ID_PATTERN.test(id)) throw new NotFoundError(`Operation "${id}" not found.`);
    return path.join(this.operationsDir, `${id}.json`);
  }

  private readOperationFile(file: string): Operation | null {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    const parsed = OperationSchema.safeParse(normalizeOperation(JSON.parse(raw)));
    if (!parsed.success) throw new TrackerError(`${file} is invalid: ${parsed.error.message}`);
    return parsed.data;
  }

  /** Opérations de tous les dépôts, de la plus récente à la plus ancienne. */
  listAllOperations(): Operation[] {
    return this.readAllOperations();
  }

  private readAllOperations(): Operation[] {
    const operations: Operation[] = [];
    for (const entry of fs.readdirSync(this.operationsDir)) {
      if (!entry.endsWith(".json")) continue;
      const operation = this.readOperationFile(path.join(this.operationsDir, entry));
      if (operation) operations.push(operation);
    }
    return operations.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private readOperationsOf(repoId: string): Operation[] {
    const key = repoId.toLowerCase();
    return this.readAllOperations().filter((operation) => operation.repoId.toLowerCase() === key);
  }

  getOperation(id: string): Operation {
    const operation = this.readOperationFile(this.operationPath(id));
    if (!operation) throw new NotFoundError(`Operation "${id}" not found.`);
    return operation;
  }

  /** Opérations d'un dépôt, de la plus récente à la plus ancienne. */
  listOperations(repoId: string): Operation[] {
    return this.readOperationsOf(repoId);
  }

  activeOperation(repoId: string): Operation | null {
    return this.readOperationsOf(repoId).find(isActive) ?? null;
  }

  /**
   * Enregistre une nouvelle opération ; refusé si une autre est en cours sur le
   * même dépôt. Les opérations terminées au-delà des 20 plus récentes sont supprimées.
   */
  createOperation(operation: Operation): Operation {
    const existing = this.readOperationsOf(operation.repoId);
    const active = existing.find(isActive);
    if (active) {
      throw new ConflictError(`An operation is already in progress on ${operation.repoId} (${active.id}, ${active.status}). Wait for it to finish or cancel it.`);
    }
    writeJsonAtomic(this.operationPath(operation.id), OperationSchema.parse(operation));
    for (const old of existing.slice(KEPT_OPERATIONS_PER_REPO - 1)) fs.rmSync(this.operationPath(old.id), { force: true });
    return operation;
  }

  updateOperation(id: string, fn: (operation: Operation) => Operation): Operation {
    const current = this.getOperation(id);
    const updated = OperationSchema.parse({ ...fn(current), updatedAt: new Date().toISOString() });
    writeJsonAtomic(this.operationPath(id), updated);
    return updated;
  }

  /**
   * Opérations encore `running` au démarrage du serveur, que son arrêt a
   * interrompues : elles passent en échec et leur clone est supprimé.
   */
  failInterruptedOperations(): Operation[] {
    const interrupted = this.readAllOperations().filter((operation) => operation.status === "running");
    return interrupted.map((operation) => {
      if (operation.workDir) fs.rmSync(operation.workDir, { recursive: true, force: true });
      return this.updateOperation(operation.id, (current) => ({
        ...current,
        status: "failed",
        error: "Interrupted: the server stopped while this operation ran.",
        steps: Object.fromEntries(Object.entries(current.steps).map(([name, state]) => [name, state === "running" ? "failed" : state])) as Operation["steps"],
        workDir: null,
      }));
    });
  }
}
