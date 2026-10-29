import { fromNpmSeverity, pendingAlerts, worstOf } from "../../shared/alerts.js";
import { ALERT_SEVERITIES, DEFAULT_RIGHTS, type Alert, type AlertSeverity, type HandledAlert, type Operation, type PullRequest, type Repo, type Rights } from "../../shared/schemas/model.schema.js";
import type { AuditFindings, RepoView } from "../../shared/schemas/api.schema.js";
import type { GitHubConfig } from "./config.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { GitHubClient, type OpenPullRequest } from "./github.js";
import { isTrackerBranch } from "./operations.js";
import { parseRepoRef } from "./repo-ref.js";
import { assertNotDeprecated, isActive, type Store } from "./store.js";

/** Ancienneté au-delà de laquelle les alertes d'un dépôt sont relues sur GitHub. */
export const SYNC_INTERVAL_MS = 10 * 60_000;

function severityRank(severity: AlertSeverity): number {
  return ALERT_SEVERITIES.indexOf(severity);
}

/** Alertes de la plus grave à la moins grave, puis par paquet. */
export function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.package.localeCompare(b.package) || a.number - b.number);
}

/** Nombre d'alertes ouvertes par gravité. */
export function countBySeverity(alerts: Alert[]): Record<AlertSeverity, number> {
  const counts = Object.fromEntries(ALERT_SEVERITIES.map((severity) => [severity, 0])) as Record<AlertSeverity, number>;
  for (const alert of alerts) counts[alert.severity] += 1;
  return counts;
}

/**
 * Dépôts triés par gravité la plus haute, puis par nombre de vulnérabilités,
 * puis par nom. Comptent les alertes non corrigées à la main et, sans alerte,
 * les vulnérabilités du dernier audit ; un dépôt sans rien de tout cela vient
 * en dernier.
 */
export function sortRepos<T extends { repo: Repo; auditFindings?: AuditFindings | null }>(views: T[]): T[] {
  const key = (view: T) => {
    const pending = pendingAlerts(view.repo);
    const severities = pending.map((alert) => alert.severity);
    if (view.auditFindings) severities.push(view.auditFindings.severity);
    const worst = severities.reduce<number>((best, severity) => Math.min(best, severityRank(severity)), ALERT_SEVERITIES.length);
    return { worst, count: pending.length + (view.auditFindings?.count ?? 0) };
  };
  return [...views].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka.worst - kb.worst || kb.count - ka.count || a.repo.id.localeCompare(b.repo.id);
  });
}

/**
 * Date du dernier audit, quand il n'a trouvé aucune vulnérabilité alors que
 * Dependabot signale encore des alertes : l'audit doit porter sur la branche
 * par défaut, la seule que Dependabot analyse, et dater d'après chacune des
 * alertes. Null sinon. `operations` va de la plus récente à la plus ancienne.
 */
export function cleanAuditAt(repo: Repo, operations: Operation[]): string | null {
  if (repo.alerts.length === 0) return null;
  const audited = operations.find((operation) => operation.steps.audit === "done");
  if (!audited || audited.counts.initial !== 0 || audited.baseBranch !== repo.defaultBranch) return null;
  const auditedAt = Date.parse(audited.createdAt);
  return repo.alerts.every((alert) => Date.parse(alert.createdAt) <= auditedAt) ? audited.createdAt : null;
}

/**
 * Vulnérabilités trouvées par le dernier audit de la branche par défaut, la
 * seule que Dependabot analyse, quand Dependabot ne signale aucune alerte.
 * Null sinon. `operations` va de la plus récente à la plus ancienne.
 */
export function auditFindings(repo: Repo, operations: Operation[]): AuditFindings | null {
  if (repo.alerts.length > 0) return null;
  const audited = operations.find((operation) => operation.steps.audit === "done" && operation.baseBranch === repo.defaultBranch);
  const severity = audited ? worstOf(audited.found.map((vulnerability) => fromNpmSeverity(vulnerability.severity))) : null;
  if (!audited || severity === null) return null;
  return { at: audited.createdAt, count: audited.found.length, severity };
}

/**
 * Paquets pour lesquels le dernier audit n'a trouvé aucune version corrigée,
 * hors ceux dont une alerte est marquée corrigée à la main. `operations` va de
 * la plus récente à la plus ancienne.
 */
export function unfixablePackages(repo: Repo, operations: Operation[]): string[] {
  const audited = operations.find((operation) => operation.steps.audit === "done");
  if (!audited) return [];
  const handled = new Set(repo.handledAlerts.map((mark) => mark.package));
  const names = audited.remaining.filter((vulnerability) => vulnerability.fix === "none" && !handled.has(vulnerability.name)).map((vulnerability) => vulnerability.name);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * Marques « corrigée à la main » encore valables après une lecture des alertes :
 * l'alerte est toujours ouverte, et aucune alerte du même paquet n'a été émise
 * depuis le marquage.
 */
export function pruneHandledAlerts(handled: HandledAlert[], alerts: Alert[]): HandledAlert[] {
  const open = new Set(alerts.map((alert) => alert.number));
  return handled.filter(
    (mark) => open.has(mark.number) && !alerts.some((alert) => alert.package === mark.package && Date.parse(alert.createdAt) > Date.parse(mark.markedAt))
  );
}

/**
 * Pull requests ouvertes par le tracker parmi celles ouvertes sur le dépôt :
 * leur branche suit le nommage `fix/npm-audit-…` et appartient au dépôt
 * lui-même, pas à une fourche. Par numéro croissant.
 */
export function trackerPullRequests(repoId: string, pulls: OpenPullRequest[]): PullRequest[] {
  return pulls
    .filter((pull) => isTrackerBranch(pull.branch) && pull.headRepo?.toLowerCase() === repoId.toLowerCase())
    .sort((a, b) => a.number - b.number)
    .map(({ number, url, branch, createdAt }) => ({ number, url, branch, createdAt }));
}

export function repoView(store: Store, repo: Repo): RepoView {
  const operations = store.listOperations(repo.id);
  return {
    repo: { ...repo, alerts: sortAlerts(repo.alerts) },
    category: repo.categoryId === null ? null : store.getCategory(repo.categoryId),
    activeOperation: operations.find(isActive) ?? null,
    latestOperation: operations[0] ?? null,
    cleanAuditAt: cleanAuditAt(repo, operations),
    auditFindings: auditFindings(repo, operations),
    unfixable: unfixablePackages(repo, operations),
  };
}

export function listRepoViews(store: Store): RepoView[] {
  store.failOrphanedOperations();
  return sortRepos(store.listRepos().map((repo) => repoView(store, repo)));
}

/**
 * Relit les alertes Dependabot ouvertes du dépôt et ses pull requests ouvertes
 * par le tracker ; un échec est enregistré dans `syncError`, données précédentes
 * conservées. Refusé sur un dépôt déprécié.
 */
export async function syncRepository(store: Store, config: GitHubConfig, repoId: string): Promise<Repo> {
  const repo = store.getRepo(repoId);
  assertNotDeprecated(repo);
  const github = new GitHubClient(config);
  try {
    const [alerts, pulls] = await Promise.all([github.listOpenAlerts(repo.owner, repo.name), github.listOpenPullRequests(repo.owner, repo.name)]);
    return store.updateRepo(repo.id, (current) => ({
      ...current,
      alerts,
      handledAlerts: pruneHandledAlerts(current.handledAlerts, alerts),
      pullRequests: trackerPullRequests(current.id, pulls),
      syncedAt: new Date().toISOString(),
      syncError: null,
    }));
  } catch (err: any) {
    const message = err?.message ?? String(err);
    return store.updateRepo(repo.id, (current) => ({ ...current, syncedAt: new Date().toISOString(), syncError: message }));
  }
}

/** Dépôts suivis qui ne sont pas dépréciés. */
export function activeRepos(store: Store): Repo[] {
  return store.listRepos().filter((repo) => repo.deprecatedAt === null);
}

/** Relit tout de suite, en parallèle, les alertes et les pull requests de chaque dépôt suivi non déprécié. */
export async function syncAllRepositories(store: Store, config: GitHubConfig): Promise<void> {
  await Promise.all(activeRepos(store).map((repo) => syncRepository(store, config, repo.id)));
}

/** Marque le dépôt déprécié ; sans effet s'il l'est déjà, refusé pendant une opération en cours. */
export function deprecateRepository(store: Store, repoId: string): Repo {
  const repo = store.getRepo(repoId);
  if (store.activeOperation(repo.id)) throw new ConflictError(`An operation is in progress on ${repo.id}: wait for it to finish or cancel it before deprecating the repository.`);
  return store.updateRepo(repo.id, (current) => (current.deprecatedAt === null ? { ...current, deprecatedAt: new Date().toISOString() } : current));
}

/** Retire la marque « déprécié », puis relit aussitôt les alertes du dépôt ; il retrouve sa catégorie. */
export async function restoreRepository(store: Store, config: GitHubConfig, repoId: string): Promise<Repo> {
  const repo = store.updateRepo(repoId, (current) => ({ ...current, deprecatedAt: null }));
  return syncRepository(store, config, repo.id);
}

/** Suit un nouveau dépôt, rangé dans `categoryId`, avec l'audit pour seul droit de l'agent, puis lit ses alertes. */
export async function addRepository(store: Store, config: GitHubConfig, input: string, categoryId: string | null): Promise<Repo> {
  const ref = parseRepoRef(input);
  if (store.findRepo(`${ref.owner}/${ref.name}`)) throw new ConflictError(`Repository ${ref.owner}/${ref.name} is already tracked.`);
  if (categoryId !== null) store.getCategory(categoryId);
  const remote = await new GitHubClient(config).getRepository(ref.owner, ref.name);
  store.addRepo({
    id: remote.fullName,
    owner: remote.owner,
    name: remote.name,
    defaultBranch: remote.defaultBranch,
    branch: remote.defaultBranch,
    categoryId,
    addedAt: new Date().toISOString(),
    rights: DEFAULT_RIGHTS,
    alerts: [],
    handledAlerts: [],
    pullRequests: [],
    syncedAt: null,
    syncError: null,
    deprecatedAt: null,
  });
  return syncRepository(store, config, remote.fullName);
}

/** Dépôts accessibles au token qui ne sont pas encore suivis, proposés à l'ajout. */
export async function listAddableRepositories(store: Store, config: GitHubConfig): Promise<string[]> {
  const tracked = new Set(store.listRepos().map((repo) => repo.id.toLowerCase()));
  const accessible = await new GitHubClient(config).listAccessibleRepositories();
  return accessible.filter((name) => !tracked.has(name.toLowerCase()));
}

/** Branches du dépôt sur GitHub, la branche par défaut en tête, les autres dans l'ordre alphabétique. */
export async function listRepoBranches(store: Store, config: GitHubConfig, repoId: string): Promise<string[]> {
  const repo = store.getRepo(repoId);
  const branches = await new GitHubClient(config).listBranches(repo.owner, repo.name);
  const others = branches.filter((branch) => branch !== repo.defaultBranch).sort((a, b) => a.localeCompare(b));
  return branches.includes(repo.defaultBranch) ? [repo.defaultBranch, ...others] : others;
}

/** Choisit la branche analysée ; elle doit exister sur GitHub. */
export async function setBranch(store: Store, config: GitHubConfig, repoId: string, branch: string): Promise<Repo> {
  const branches = await listRepoBranches(store, config, repoId);
  if (!branches.includes(branch)) throw new NotFoundError(`Branch "${branch}" does not exist in ${store.getRepo(repoId).id}.`);
  return store.updateRepo(repoId, (repo) => ({ ...repo, branch }));
}

/** Range le dépôt dans une catégorie, ou dans aucune avec null. */
export function setCategory(store: Store, repoId: string, categoryId: string | null): Repo {
  return store.updateRepo(repoId, (repo) => ({ ...repo, categoryId }));
}

/** Marque une alerte ouverte comme corrigée à la main ; sans effet si elle l'est déjà. */
export function markAlertHandled(store: Store, repoId: string, number: number): Repo {
  return store.updateRepo(repoId, (repo) => {
    const alert = repo.alerts.find((candidate) => candidate.number === number);
    if (!alert) throw new NotFoundError(`Alert #${number} is not open on ${repo.id}.`);
    if (repo.handledAlerts.some((mark) => mark.number === number)) return repo;
    return { ...repo, handledAlerts: [...repo.handledAlerts, { number, package: alert.package, markedAt: new Date().toISOString() }] };
  });
}

/** Retire la marque « corrigée à la main » d'une alerte. */
export function unmarkAlertHandled(store: Store, repoId: string, number: number): Repo {
  return store.updateRepo(repoId, (repo) => ({ ...repo, handledAlerts: repo.handledAlerts.filter((mark) => mark.number !== number) }));
}

export function setRights(store: Store, repoId: string, rights: Rights): Repo {
  return store.updateRepo(repoId, (repo) => ({ ...repo, rights }));
}

/** Dépôts non dépréciés jamais synchronisés, ou synchronisés il y a plus de `maxAgeMs`. */
export function staleRepos(store: Store, maxAgeMs: number, at = Date.now()): Repo[] {
  return activeRepos(store).filter((repo) => repo.syncedAt === null || at - Date.parse(repo.syncedAt) > maxAgeMs);
}
