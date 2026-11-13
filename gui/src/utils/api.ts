import type { AddableReposResponse, AppConfig, AuditAllResponse, AuditTarget, BranchesResponse, CategoriesResponse, OperationResponse, OperationsResponse, ReposResponse, RepoView } from '@shared/schemas/api.schema'
import type { AgentTokensResponse, CreatedAgentTokenResponse } from '@shared/schemas/agent-token.schema'
import type { DeployServerBody, DeploymentResponse, DeployServersResponse, DeployServerView, RepoDeployResponse, RotationResponse, TestDeployServerResponse } from '@shared/schemas/deploy.schema'
import type { AuditScope, Category } from '@shared/schemas/model.schema'
import type { SaveSettingsBody, SettingsView } from '@shared/schemas/settings.schema'

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
 * variable, résolu par la balise <base> injectée par le serveur.
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

function categoryPath(id: string): string {
  return `categories/${encodeURIComponent(id)}`
}

function operationPath(id: string): string {
  return `operations/${encodeURIComponent(id)}`
}

export const api = {
  getConfig: () => request<AppConfig>('config'),
  listRepos: () => request<ReposResponse>('repos'),
  syncRepos: () => send<ReposResponse>('POST', 'sync'),
  getAuditAll: () => request<AuditAllResponse>('audit-all'),
  startAuditAll: (scope: AuditScope, target: AuditTarget) => send<AuditAllResponse>('POST', 'audit-all', { scope, target }),
  listAddableRepos: () => request<AddableReposResponse>('github/repos'),
  getRepo: (repoId: string) => request<RepoView>(repoPath(repoId)),
  addRepo: (repository: string, categoryId: string | null) => send<RepoView>('POST', 'repos', { repository, categoryId }),
  removeRepo: (repoId: string) => send<{ removed: true }>('DELETE', repoPath(repoId)),
  deprecateRepo: (repoId: string) => send<RepoView>('PUT', `${repoPath(repoId)}/deprecated`),
  restoreRepo: (repoId: string) => send<RepoView>('DELETE', `${repoPath(repoId)}/deprecated`),
  queueRepo: (repoId: string) => send<RepoView>('PUT', `${repoPath(repoId)}/queued`),
  unqueueRepo: (repoId: string) => send<RepoView>('DELETE', `${repoPath(repoId)}/queued`),
  markDeployPending: (repoId: string) => send<RepoView>('PUT', `${repoPath(repoId)}/deploy-pending`),
  unmarkDeployPending: (repoId: string) => send<RepoView>('DELETE', `${repoPath(repoId)}/deploy-pending`),
  markMerged: (repoId: string, deploy: boolean) => send<RepoView>('PUT', `${repoPath(repoId)}/merged`, { deploy }),
  listBranches:(repoId: string) => request<BranchesResponse>(`${repoPath(repoId)}/branches`),
  setBranch: (repoId: string, branch: string) => send<RepoView>('PUT', `${repoPath(repoId)}/branch`, { branch }),
  markAlertHandled: (repoId: string, number: number) => send<RepoView>('PUT', `${repoPath(repoId)}/alerts/${number}/handled`),
  unmarkAlertHandled: (repoId: string, number: number) => send<RepoView>('DELETE', `${repoPath(repoId)}/alerts/${number}/handled`),
  setCategory: (repoId: string, categoryId: string | null) => send<RepoView>('PUT', `${repoPath(repoId)}/category`, { categoryId }),
  listCategories: () => request<CategoriesResponse>('categories'),
  createCategory: (name: string) => send<Category>('POST', 'categories', { name }),
  renameCategory: (id: string, name: string) => send<Category>('PUT', categoryPath(id), { name }),
  deleteCategory: (id: string) => send<{ deleted: true }>('DELETE', categoryPath(id)),
  queueCategory: (id: string) => send<ReposResponse>('PUT', `${categoryPath(id)}/queued`),
  startFix: (repoId: string, scope: AuditScope) => send<OperationResponse>('POST', `${repoPath(repoId)}/operations`, { scope }),
  getOperation: (id: string) => request<OperationResponse>(operationPath(id)),
  listOperations: (repoId: string) => request<OperationsResponse>(`${repoPath(repoId)}/operations`),
  cancel: (id: string) => send<OperationResponse>('POST', `${operationPath(id)}/cancel`),
  getSettings: () => request<SettingsView>('settings'),
  saveSettings: (body: SaveSettingsBody) => send<SettingsView>('PUT', 'settings', body),
  testOrganizer: () => send<SettingsView>('POST', 'settings/organizer/test'),
  listAgentTokens: () => request<AgentTokensResponse>('agent-tokens'),
  createAgentToken: (name: string) => send<CreatedAgentTokenResponse>('POST', 'agent-tokens', { name }),
  revokeAgentToken: (id: string) => send<{ revoked: true }>('DELETE', `agent-tokens/${encodeURIComponent(id)}`),
  listDeployServers: () => request<DeployServersResponse>('deploy-servers'),
  createDeployServer: (body: DeployServerBody) => send<DeployServerView>('POST', 'deploy-servers', body),
  updateDeployServer: (id: string, body: DeployServerBody) => send<DeployServerView>('PUT', `deploy-servers/${encodeURIComponent(id)}`, body),
  testDeployServer: (id: string) => send<TestDeployServerResponse>('POST', `deploy-servers/${encodeURIComponent(id)}/test`),
  installDeployKey: (id: string) => send<DeployServerView>('POST', `deploy-servers/${encodeURIComponent(id)}/key`),
  rotateDeployKey: (id: string) => send<RotationResponse>('POST', `deploy-servers/${encodeURIComponent(id)}/key/rotate`),
  revokeDeployKey: (id: string) => send<DeployServerView>('POST', `deploy-servers/${encodeURIComponent(id)}/key/revoke`),
  forgetDeployKey: (id: string) => send<DeployServerView>('POST', `deploy-servers/${encodeURIComponent(id)}/key/forget`),
  getRepoDeploy: (repoId: string) => request<RepoDeployResponse>(`${repoPath(repoId)}/deploy`),
  setRepoDeployServer: (repoId: string, serverId: string | null) => send<RepoDeployResponse>('PUT', `${repoPath(repoId)}/deploy/server`, { serverId }),
  saveRepoDeployScript: (repoId: string, script: string) => send<RepoDeployResponse>('PUT', `${repoPath(repoId)}/deploy/script`, { script }),
  startDeployment: (repoId: string) => send<DeploymentResponse>('POST', `${repoPath(repoId)}/deployments`),
  getDeployment: (id: string) => request<DeploymentResponse>(`deployments/${encodeURIComponent(id)}`),
  cancelDeployment: (id: string) => send<DeploymentResponse>('POST', `deployments/${encodeURIComponent(id)}/cancel`),
}
