import { TrackerError } from "./errors.js";

/**
 * Accès à GitHub. `apiUrl` et `serverUrl` désignent github.com par défaut ;
 * GITHUB_API_URL et GITHUB_SERVER_URL les changent pour GitHub Enterprise Server.
 */
export interface GitHubConfig {
  token: string;
  apiUrl: string;
  serverUrl: string;
}

const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_SERVER_URL = "https://github.com";

export function githubConfigured(): boolean {
  return !!process.env.GITHUB_TOKEN?.trim();
}

/** Configuration GitHub lue dans l'environnement ; lève une erreur si GITHUB_TOKEN manque. */
export function readGitHubConfig(): GitHubConfig {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new TrackerError(
      "GITHUB_TOKEN is not set: declare a GitHub token in the env block of mcp-dependabot-tracker (Dependabot alerts: read, Contents: read and write, Pull requests: read and write)."
    );
  }
  return {
    token,
    apiUrl: (process.env.GITHUB_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, ""),
    serverUrl: (process.env.GITHUB_SERVER_URL?.trim() || DEFAULT_SERVER_URL).replace(/\/+$/, ""),
  };
}
