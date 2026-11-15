import { TrackerError } from "./errors.js";

/**
 * Accès à GitHub. `apiUrl` et `serverUrl` désignent github.com par défaut ;
 * GITHUB_API_URL et GITHUB_SERVER_URL les changent pour GitHub Enterprise Server.
 * `serverUrl` est l'adresse web du serveur, sans barre finale :
 * `<serveur>/<propriétaire>/<nom>` est la page d'un dépôt.
 */
export interface GitHubConfig {
  token: string;
  apiUrl: string;
  serverUrl: string;
}

/** Adresses du serveur GitHub, sans le token. */
export type GitHubServers = Omit<GitHubConfig, "token">;

const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_SERVER_URL = "https://github.com";

/** Adresses de l'API et du serveur GitHub lues dans l'environnement, github.com par défaut. */
export function readGitHubServers(env: NodeJS.ProcessEnv = process.env): GitHubServers {
  return {
    apiUrl: (env.GITHUB_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, ""),
    serverUrl: (env.GITHUB_SERVER_URL?.trim() || DEFAULT_SERVER_URL).replace(/\/+$/, ""),
  };
}

/** Configuration GitHub avec le token du tracker ; lève une erreur qui renvoie aux réglages sans token. */
export function gitHubConfig(servers: GitHubServers, token: string | null): GitHubConfig {
  if (!token) {
    throw new TrackerError(
      "The GitHub token of the tracker is not set: enter it in the settings (Réglages › GitHub), with Dependabot alerts: read, Contents and Pull requests: read and write."
    );
  }
  return { ...servers, token };
}
