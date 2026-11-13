import type { AgentOperationResponse, AgentReposResponse, RepoView } from "../../shared/schemas/api.schema.js";
import type { AuditScope } from "../../shared/schemas/model.schema.js";

/** Délai de réponse du serveur ; la relecture des alertes interroge GitHub. */
const REQUEST_TIMEOUT_MS = 45_000;

/** Chemin d'un dépôt `propriétaire/nom` : deux segments encodés séparément. */
function repoPath(repository: string): string {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) throw new Error(`"repository" must be owner/name (got ${JSON.stringify(repository)}).`);
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** Client de l'API des agents du serveur Dependabot Tracker, authentifié par un token d'agent. */
export class AgentClient {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string
  ) {}

  private async request<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
    const url = `${this.serverUrl}/api/agent/${route}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: any) {
      throw new Error(`The Dependabot Tracker server at ${this.serverUrl} cannot be reached: ${err?.cause?.message ?? err?.message ?? err}`);
    }
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`The Dependabot Tracker server answered ${method} ${url} with HTTP ${response.status} and no JSON: ${text.slice(0, 300)}`);
    }
    if (!response.ok) throw new Error(json?.error ?? `HTTP ${response.status}`);
    return json as T;
  }

  listRepositories(category: string | undefined): Promise<AgentReposResponse> {
    return this.request("GET", category === undefined ? "repos" : `repos?category=${encodeURIComponent(category)}`);
  }

  syncAlerts(repository: string): Promise<RepoView> {
    return this.request("POST", `${repoPath(repository)}/sync`);
  }

  startAudit(repository: string, scope: AuditScope): Promise<AgentOperationResponse> {
    return this.request("POST", `${repoPath(repository)}/audits`, { scope });
  }

  startFix(repository: string, scope: AuditScope, claude: boolean): Promise<AgentOperationResponse> {
    return this.request("POST", `${repoPath(repository)}/fixes`, { scope, claude });
  }

  getOperation(id: string): Promise<AgentOperationResponse> {
    return this.request("GET", `operations/${encodeURIComponent(id)}`);
  }

  cancelOperation(id: string): Promise<AgentOperationResponse> {
    return this.request("POST", `operations/${encodeURIComponent(id)}/cancel`);
  }
}
