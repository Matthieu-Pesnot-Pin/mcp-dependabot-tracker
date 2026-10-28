import type { AddableReposResponse, AppConfig, OperationResponse, ReposResponse, RepoView } from '@shared/schemas/api.schema'
import type { Rights } from '@shared/schemas/model.schema'

/** Erreur HTTP de l'API ; `status` distingue un conflit (409) des autres échecs. */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Les routes sont relatives : la SPA est montée derrière un préfixe de proxy
 * variable, résolu par la balise <base> injectée par le GUI worker.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`api/${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (body?.error) message = body.error
    } catch {
      // Réponse non-JSON : le code HTTP reste le message disponible.
    }
    throw new ApiError(response.status, message)
  }
  return (await response.json()) as T
}

function send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
}

/** Chemin d'un dépôt `propriétaire/nom` : deux segments encodés séparément. */
function repoPath(repoId: string): string {
  const [owner, name] = repoId.split('/')
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

function operationPath(id: string): string {
  return `operations/${encodeURIComponent(id)}`
}

export const api = {
  getConfig: () => request<AppConfig>('config'),
  listRepos: () => request<ReposResponse>('repos'),
  listAddableRepos: () => request<AddableReposResponse>('github/repos'),
  getRepo: (repoId: string) => request<RepoView>(repoPath(repoId)),
  addRepo: (repository: string) => send<RepoView>('POST', 'repos', { repository }),
  removeRepo: (repoId: string) => send<{ removed: true }>('DELETE', repoPath(repoId)),
  setRights: (repoId: string, rights: Rights) => send<RepoView>('PUT', `${repoPath(repoId)}/rights`, { rights }),
  startFix: (repoId: string) => send<OperationResponse>('POST', `${repoPath(repoId)}/operations`),
  getOperation: (id: string) => request<OperationResponse>(operationPath(id)),
  decideForce: (id: string, apply: boolean) => send<OperationResponse>('POST', `${operationPath(id)}/force`, { apply }),
  push: (id: string, commitMessage: string) => send<OperationResponse>('POST', `${operationPath(id)}/push`, { commitMessage }),
  cancel: (id: string) => send<OperationResponse>('POST', `${operationPath(id)}/cancel`),
}
