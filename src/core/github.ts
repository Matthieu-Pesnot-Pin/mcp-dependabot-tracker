import { ALERT_SEVERITIES, type Alert, type AlertSeverity } from "../../shared/schemas/model.schema.js";
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

export interface PullRequest {
  number: number;
  url: string;
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

/** Client REST minimal de l'API GitHub, authentifié par le token de la configuration. */
export class GitHubClient {
  constructor(private readonly config: GitHubConfig) {}

  private async request(method: string, url: string, body?: unknown): Promise<{ json: any; link: string | null }> {
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
      if (response.status === 401) throw new TrackerError(`GitHub rejected GITHUB_TOKEN (401: ${message}).`);
      throw new GitHubApiError(response.status, `GitHub API ${method} ${url} failed (${response.status}): ${message}`);
    }
    return { json, link: response.headers.get("link") };
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

  async getAuthenticatedUser(): Promise<GitHubUser> {
    const { json } = await this.request("GET", "/user");
    return { login: json.login, id: json.id, name: json.name ?? null };
  }

  async createPullRequest(owner: string, name: string, pr: { title: string; head: string; base: string; body: string }): Promise<PullRequest> {
    const { json } = await this.request("POST", `/repos/${owner}/${name}/pulls`, pr);
    return { number: json.number, url: json.html_url };
  }
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
  };
}
