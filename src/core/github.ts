import { ALERT_SEVERITIES, DEPENDENCY_SCOPES, type Alert, type AlertSeverity, type DependencyScope } from "../../shared/schemas/model.schema.js";
import type { GitHubConfig } from "./config.js";
import { NotFoundError, TrackerError } from "./errors.js";

/** Dépôt GitHub tel que le tracker l'enregistre. */
export interface GitHubRepository {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

/** Compte du token, auteur des commits de correction. */
export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
}

/** Compte d'un token et sa date d'expiration (ISO), null pour un token sans expiration. */
export interface TokenCheck {
  login: string;
  expiresAt: string | null;
}

/** Date d'expiration d'un token telle que GitHub l'envoie (`2026-12-14 14:31:47 UTC`), en ISO. */
export function tokenExpiration(header: string | null): string | null {
  if (!header) return null;
  const date = new Date(header.trim().replace(/ UTC$/, "Z").replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Pull request créée ; `createdAt` est sa date d'ouverture. */
export interface CreatedPullRequest {
  number: number;
  url: string;
  createdAt: string;
}

/** Pull request ouverte ; `headRepo` est le dépôt de sa branche, null si ce dépôt a été supprimé. */
export interface OpenPullRequest {
  number: number;
  url: string;
  branch: string;
  headRepo: string | null;
  createdAt: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** Nombre maximal de pages d'alertes lues (100 alertes par page). */
const MAX_ALERT_PAGES = 20;

/** Nombre maximal de pages de dépôts ou de branches lues (100 par page). */
const MAX_REPOSITORY_PAGES = 30;

/** URL de la page suivante dans un en-tête `Link` de pagination, ou null. */
export function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return null;
}

/**
 * Client REST minimal de l'API GitHub, authentifié par le token de la
 * configuration ; `tokenName` désigne ce token dans le message d'un refus.
 */
export class GitHubClient {
  constructor(
    private readonly config: GitHubConfig,
    private readonly tokenName = "GITHUB_TOKEN"
  ) {}

  private async request(method: string, url: string, body?: unknown): Promise<{ json: any; link: string | null; expiration: string | null }> {
    let response: Response;
    try {
      response = await fetch(url.startsWith("http") ? url : `${this.config.apiUrl}${url}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.config.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mcp-dependabot-tracker",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: any) {
      throw new TrackerError(`GitHub API unreachable (${method} ${url}): ${err?.message ?? err}`);
    }
    const text = await response.text();
    let json: any = null;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        throw new TrackerError(`GitHub API returned a non-JSON response (${method} ${url}, HTTP ${response.status}).`);
      }
    }
    if (!response.ok) {
      const message = typeof json?.message === "string" ? json.message : `HTTP ${response.status}`;
      if (response.status === 401) throw new TrackerError(`GitHub rejected ${this.tokenName} (401: ${message}).`);
      throw new GitHubApiError(response.status, `GitHub API ${method} ${url} failed (${response.status}): ${message}`);
    }
    return { json, link: response.headers.get("link"), expiration: response.headers.get("github-authentication-token-expiration") };
  }

  async getRepository(owner: string, name: string): Promise<GitHubRepository> {
    try {
      const { json } = await this.request("GET", `/repos/${owner}/${name}`);
      return { owner: json.owner.login, name: json.name, fullName: json.full_name, defaultBranch: json.default_branch };
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        throw new NotFoundError(`Repository ${owner}/${name} not found on GitHub, or GITHUB_TOKEN cannot access it.`);
      }
      throw err;
    }
  }

  /** Alertes Dependabot ouvertes du dépôt, toutes pages comprises. */
  async listOpenAlerts(owner: string, name: string): Promise<Alert[]> {
    const alerts: Alert[] = [];
    let url: string | null = `/repos/${owner}/${name}/dependabot/alerts?state=open&per_page=100`;
    for (let page = 0; url !== null; page += 1) {
      if (page === MAX_ALERT_PAGES) {
        throw new TrackerError(`${owner}/${name} has more than ${MAX_ALERT_PAGES * 100} open Dependabot alerts; the tracker reads at most that many.`);
      }
      const { json, link } = await this.request("GET", url);
      if (!Array.isArray(json)) throw new TrackerError(`GitHub API returned an unexpected list of alerts for ${owner}/${name}.`);
      for (const raw of json) alerts.push(toAlert(raw));
      url = nextPageUrl(link);
    }
    return alerts;
  }

  /** Noms complets (`propriétaire/nom`) des dépôts accessibles au token, toutes pages comprises. */
  async listAccessibleRepositories(): Promise<string[]> {
    const names: string[] = [];
    let url: string | null = "/user/repos?per_page=100&sort=full_name";
    for (let page = 0; url !== null; page += 1) {
      if (page === MAX_REPOSITORY_PAGES) {
        throw new TrackerError(`GITHUB_TOKEN can access more than ${MAX_REPOSITORY_PAGES * 100} repositories; the tracker lists at most that many.`);
      }
      const { json, link } = await this.request("GET", url);
      if (!Array.isArray(json)) throw new TrackerError("GitHub API returned an unexpected list of repositories.");
      for (const raw of json) names.push(raw.full_name);
      url = nextPageUrl(link);
    }
    return names;
  }

  /** Noms des branches du dépôt, toutes pages comprises. */
  async listBranches(owner: string, name: string): Promise<string[]> {
    const names: string[] = [];
    let url: string | null = `/repos/${owner}/${name}/branches?per_page=100`;
    for (let page = 0; url !== null; page += 1) {
      if (page === MAX_REPOSITORY_PAGES) {
        throw new TrackerError(`${owner}/${name} has more than ${MAX_REPOSITORY_PAGES * 100} branches; the tracker lists at most that many.`);
      }
      const { json, link } = await this.request("GET", url);
      if (!Array.isArray(json)) throw new TrackerError(`GitHub API returned an unexpected list of branches for ${owner}/${name}.`);
      for (const raw of json) names.push(raw.name);
      url = nextPageUrl(link);
    }
    return names;
  }

  /** SHA du dernier commit de `branch`. */
  async getBranchCommit(owner: string, name: string, branch: string): Promise<string> {
    const { json } = await this.request("GET", `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`);
    const sha = json?.commit?.sha;
    if (typeof sha !== "string") throw new TrackerError(`GitHub API returned no commit for the branch ${branch} of ${owner}/${name}.`);
    return sha;
  }

  /** Compte du token et sa date d'expiration ; un token refusé lève une erreur. */
  async checkToken(): Promise<TokenCheck> {
    const { json, expiration } = await this.request("GET", "/user");
    return { login: json.login, expiresAt: tokenExpiration(expiration) };
  }

  async getAuthenticatedUser(): Promise<GitHubUser> {
    const { json } = await this.request("GET", "/user");
    return { login: json.login, id: json.id, name: json.name ?? null };
  }

  /** Pull requests ouvertes du dépôt, toutes pages comprises. */
  async listOpenPullRequests(owner: string, name: string): Promise<OpenPullRequest[]> {
    const pulls: OpenPullRequest[] = [];
    let url: string | null = `/repos/${owner}/${name}/pulls?state=open&per_page=100`;
    for (let page = 0; url !== null; page += 1) {
      if (page === MAX_REPOSITORY_PAGES) {
        throw new TrackerError(`${owner}/${name} has more than ${MAX_REPOSITORY_PAGES * 100} open pull requests; the tracker reads at most that many.`);
      }
      const { json, link } = await this.request("GET", url);
      if (!Array.isArray(json)) throw new TrackerError(`GitHub API returned an unexpected list of pull requests for ${owner}/${name}.`);
      for (const raw of json) {
        pulls.push({ number: raw.number, url: raw.html_url, branch: raw.head?.ref ?? "", headRepo: raw.head?.repo?.full_name ?? null, createdAt: raw.created_at });
      }
      url = nextPageUrl(link);
    }
    return pulls;
  }

  async createPullRequest(owner: string, name: string, pr: { title: string; head: string; base: string; body: string }): Promise<CreatedPullRequest> {
    const { json } = await this.request("POST", `/repos/${owner}/${name}/pulls`, pr);
    return { number: json.number, url: json.html_url, createdAt: json.created_at };
  }

  /** État d'une pull request : ouverte ou fermée, mergée ou non, et le commit de sa branche. */
  async getPullRequest(owner: string, name: string, number: number): Promise<PullRequestState> {
    const { json } = await this.request("GET", `/repos/${owner}/${name}/pulls/${number}`);
    if (typeof json?.head?.sha !== "string") throw new TrackerError(`GitHub API returned no head commit for pull request #${number} of ${owner}/${name}.`);
    return { state: json.state === "closed" ? "closed" : "open", merged: json.merged === true, headSha: json.head.sha, mergeCommit: json.merge_commit_sha ?? null };
  }

  /**
   * Checks du commit `sha` : check runs (100 premiers) et statuts de commit.
   * Un check est en attente tant qu'il n'est pas terminé ; il échoue sur une
   * conclusion autre que success, neutral ou skipped, ou un statut error ou failure.
   */
  async getChecks(owner: string, name: string, sha: string): Promise<CommitChecks> {
    const [runs, status] = await Promise.all([
      this.request("GET", `/repos/${owner}/${name}/commits/${sha}/check-runs?per_page=100`),
      this.request("GET", `/repos/${owner}/${name}/commits/${sha}/status`),
    ]);
    const checks: CommitCheck[] = [];
    for (const run of Array.isArray(runs.json?.check_runs) ? runs.json.check_runs : []) {
      const state = run.status !== "completed" ? "pending" : PASSING_CONCLUSIONS.has(run.conclusion) ? "success" : "failure";
      checks.push({ name: String(run.name ?? "check"), state });
    }
    for (const entry of Array.isArray(status.json?.statuses) ? status.json.statuses : []) {
      const state = entry.state === "success" ? "success" : entry.state === "pending" ? "pending" : "failure";
      checks.push({ name: String(entry.context ?? "status"), state });
    }
    return { checks };
  }

  /**
   * Merge la pull request par un commit de merge, à condition que sa branche
   * soit encore au commit `sha` ; rend le commit du merge.
   */
  async mergePullRequest(owner: string, name: string, number: number, sha: string): Promise<string> {
    let json: any;
    try {
      ({ json } = await this.request("PUT", `/repos/${owner}/${name}/pulls/${number}/merge`, { merge_method: "merge", sha }));
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 409) throw new TrackerError(`The branch of pull request #${number} moved after its checks: it was not merged.`);
      if (err instanceof GitHubApiError && (err.status === 405 || err.status === 403)) throw new TrackerError(`GitHub refused to merge pull request #${number}: ${err.message}`);
      throw err;
    }
    if (json?.merged !== true || typeof json?.sha !== "string") throw new TrackerError(`GitHub did not merge pull request #${number}: ${json?.message ?? "no reason given"}.`);
    return json.sha;
  }
}

/** Conclusions d'un check run terminé qui ne bloquent pas le merge. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** État d'une pull request ; `mergeCommit` est le commit de son merge, null avant. */
export interface PullRequestState {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  mergeCommit: string | null;
}

/** Check d'un commit : check run ou statut, réduit à son nom et son état. */
export interface CommitCheck {
  name: string;
  state: "pending" | "success" | "failure";
}

export interface CommitChecks {
  checks: CommitCheck[];
}

/** Échec HTTP de l'API GitHub, avec son code. */
export class GitHubApiError extends TrackerError {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

function toAlert(raw: any): Alert {
  const severity = raw?.security_advisory?.severity ?? raw?.security_vulnerability?.severity;
  if (!(ALERT_SEVERITIES as readonly string[]).includes(severity)) {
    throw new TrackerError(`Dependabot alert #${raw?.number} has an unknown severity: ${JSON.stringify(severity)}.`);
  }
  if (typeof raw?.created_at !== "string") {
    throw new TrackerError(`Dependabot alert #${raw?.number} has no creation date.`);
  }
  return {
    number: raw.number,
    severity: severity as AlertSeverity,
    ecosystem: raw.dependency?.package?.ecosystem ?? "",
    package: raw.dependency?.package?.name ?? "",
    manifestPath: raw.dependency?.manifest_path ?? "",
    summary: raw.security_advisory?.summary ?? "",
    url: raw.html_url ?? "",
    patchedVersion: raw.security_vulnerability?.first_patched_version?.identifier ?? null,
    createdAt: raw.created_at,
    scope: (DEPENDENCY_SCOPES as readonly string[]).includes(raw.dependency?.scope) ? (raw.dependency.scope as DependencyScope) : null,
  };
}
