import { ALERT_SEVERITIES, DEFAULT_RIGHTS, type Alert, type AlertSeverity, type Repo, type Rights } from "../../shared/schemas/model.schema.js";
import type { RepoView } from "../../shared/schemas/api.schema.js";
import type { GitHubConfig } from "./config.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { GitHubClient } from "./github.js";
import { parseRepoRef } from "./repo-ref.js";
import { isActive, type Store } from "./store.js";

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

/** Dépôts triés par gravité la plus haute, puis par nombre d'alertes, puis par nom ; un dépôt sans alerte vient en dernier. */
export function sortRepos<T extends { repo: Repo }>(views: T[]): T[] {
  const key = (repo: Repo) => {
    const worst = repo.alerts.reduce<number>((best, alert) => Math.min(best, severityRank(alert.severity)), ALERT_SEVERITIES.length);
    return { worst, count: repo.alerts.length };
  };
  return [...views].sort((a, b) => {
    const ka = key(a.repo);
    const kb = key(b.repo);
    return ka.worst - kb.worst || kb.count - ka.count || a.repo.id.localeCompare(b.repo.id);
  });
}

export function repoView(store: Store, repo: Repo): RepoView {
  const operations = store.listOperations(repo.id);
  return {
    repo: { ...repo, alerts: sortAlerts(repo.alerts) },
    activeOperation: operations.find(isActive) ?? null,
    latestOperation: operations[0] ?? null,
  };
}

export function listRepoViews(store: Store): RepoView[] {
  store.failOrphanedOperations();
  return sortRepos(store.listRepos().map((repo) => repoView(store, repo)));
}

/** Relit les alertes Dependabot ouvertes du dépôt ; un échec est enregistré dans `syncError`, alertes précédentes conservées. */
export async function syncRepository(store: Store, config: GitHubConfig, repoId: string): Promise<Repo> {
  const repo = store.getRepo(repoId);
  const github = new GitHubClient(config);
  try {
    const alerts = await github.listOpenAlerts(repo.owner, repo.name);
    return store.updateRepo(repo.id, (current) => ({ ...current, alerts, syncedAt: new Date().toISOString(), syncError: null }));
  } catch (err: any) {
    const message = err?.message ?? String(err);
    return store.updateRepo(repo.id, (current) => ({ ...current, syncedAt: new Date().toISOString(), syncError: message }));
  }
}

/** Suit un nouveau dépôt, avec l'audit pour seul droit de l'agent, puis lit ses alertes. */
export async function addRepository(store: Store, config: GitHubConfig, input: string): Promise<Repo> {
  const ref = parseRepoRef(input);
  if (store.findRepo(`${ref.owner}/${ref.name}`)) throw new ConflictError(`Repository ${ref.owner}/${ref.name} is already tracked.`);
  const remote = await new GitHubClient(config).getRepository(ref.owner, ref.name);
  store.addRepo({
    id: remote.fullName,
    owner: remote.owner,
    name: remote.name,
    defaultBranch: remote.defaultBranch,
    branch: remote.defaultBranch,
    addedAt: new Date().toISOString(),
    rights: DEFAULT_RIGHTS,
    alerts: [],
    syncedAt: null,
    syncError: null,
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

export function setRights(store: Store, repoId: string, rights: Rights): Repo {
  return store.updateRepo(repoId, (repo) => ({ ...repo, rights }));
}

/** Dépôts jamais synchronisés, ou synchronisés il y a plus de `maxAgeMs`. */
export function staleRepos(store: Store, maxAgeMs: number, at = Date.now()): Repo[] {
  return store.listRepos().filter((repo) => repo.syncedAt === null || at - Date.parse(repo.syncedAt) > maxAgeMs);
}
