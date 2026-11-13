import { useSyncExternalStore } from 'react'

/**
 * Écran désigné par le hash de l'URL :
 *   `#/`                                accueil, tous les dépôts suivis ;
 *   `#/c/<catégorie>`                   accueil, dépôts d'une catégorie ;
 *   `#/queue`                           accueil, file d'attente ;
 *   `#/pulls`                           accueil, dépôts dont une PR attend ;
 *   `#/deploy`                          accueil, dépôts à déployer ;
 *   `#/deprecated`                      accueil, dépôts dépréciés ;
 *   `#/settings`                        réglages des corrections par Claude ;
 *   `#/r/<propriétaire>/<nom>`          écran du dépôt, ses alertes ;
 *   `#/r/<propriétaire>/<nom>/history`  écran du dépôt, son historique ;
 *   `#/r/<propriétaire>/<nom>/deploy`   écran du dépôt, son déploiement ;
 *   `#/r/<propriétaire>/<nom>/deploy/<id>`  écran du dépôt, un déploiement ;
 *   `#/r/<propriétaire>/<nom>/op/<id>`  écran d'une opération.
 */
export type Route =
  | { name: 'home'; categoryId: string | null }
  | { name: 'queue' }
  | { name: 'pulls' }
  | { name: 'deploy' }
  | { name: 'deprecated' }
  | { name: 'settings' }
  | { name: 'repo'; repoId: string; tab: RepoTab; deploymentId: string | null }
  | { name: 'operation'; repoId: string; operationId: string }
  | { name: 'not_found'; hash: string }

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function parseHash(hash: string): Route {
  const segments = hash
    .replace(/^#/, '')
    .split('/')
    .filter((segment) => segment !== '')
    .map(decode)
  if (segments.length === 0) return { name: 'home', categoryId: null }
  if (segments.some((segment) => segment === null)) return { name: 'not_found', hash }
  if (segments.length === 2 && segments[0] === 'c') return { name: 'home', categoryId: segments[1] }
  if (segments.length === 1 && segments[0] === 'queue') return { name: 'queue' }
  if (segments.length === 1 && segments[0] === 'pulls') return { name: 'pulls' }
  if (segments.length === 1 && segments[0] === 'deploy') return { name: 'deploy' }
  if (segments.length === 1 && segments[0] === 'deprecated') return { name: 'deprecated' }
  if (segments.length === 1 && segments[0] === 'settings') return { name: 'settings' }
  const [section, owner, name, sub, subId] = segments as string[]
  if (section !== 'r' || !owner || !name) return { name: 'not_found', hash }
  const repoId = `${owner}/${name}`
  if (segments.length === 3) return { name: 'repo', repoId, tab: 'alerts', deploymentId: null }
  if (segments.length === 4 && sub === 'history') return { name: 'repo', repoId, tab: 'history', deploymentId: null }
  if (segments.length === 4 && sub === 'deploy') return { name: 'repo', repoId, tab: 'deploy', deploymentId: null }
  if (segments.length === 5 && sub === 'deploy') return { name: 'repo', repoId, tab: 'deploy', deploymentId: subId }
  if (segments.length === 5 && sub === 'op') return { name: 'operation', repoId, operationId: subId }
  return { name: 'not_found', hash }
}

/** Adresse de la page courante suivie de `hash`. */
function inPage(hash: string): string {
  return `${window.location.pathname}${window.location.search}${hash}`
}

function repoHash(repoId: string): string {
  const [owner, name] = repoId.split('/')
  return `#/r/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/** Onglet de l'écran d'un dépôt. */
export type RepoTab = 'alerts' | 'history' | 'deploy'

/** Onglet de l'accueil : une catégorie, tous les projets (`categoryId` null), la file d'attente, les PR en attente, les dépôts à déployer, ou les dépôts dépréciés. */
export type HomeTab = { kind: 'category'; categoryId: string | null } | { kind: 'queue' } | { kind: 'pulls' } | { kind: 'deploy' } | { kind: 'deprecated' }

/** Onglet affiché par l'accueil la dernière fois, où ramènent les retours depuis un dépôt. */
let lastHomeTab: HomeTab = { kind: 'category', categoryId: null }

export function rememberHomeTab(tab: HomeTab) {
  lastHomeTab = tab
}

export const hrefs = {
  home: (categoryId: string | null = null) => inPage(categoryId === null ? '#/' : `#/c/${encodeURIComponent(categoryId)}`),
  queue: () => inPage('#/queue'),
  pulls: () => inPage('#/pulls'),
  deploy: () => inPage('#/deploy'),
  deprecated: () => inPage('#/deprecated'),
  settings: () => inPage('#/settings'),
  lastHome: () => {
    if (lastHomeTab.kind === 'category') return hrefs.home(lastHomeTab.categoryId)
    if (lastHomeTab.kind === 'queue') return hrefs.queue()
    if (lastHomeTab.kind === 'pulls') return hrefs.pulls()
    if (lastHomeTab.kind === 'deploy') return hrefs.deploy()
    return hrefs.deprecated()
  },
  repo: (repoId: string) => inPage(repoHash(repoId)),
  repoHistory: (repoId: string) => inPage(`${repoHash(repoId)}/history`),
  repoDeploy: (repoId: string) => inPage(`${repoHash(repoId)}/deploy`),
  deployment: (repoId: string, deploymentId: string) => inPage(`${repoHash(repoId)}/deploy/${encodeURIComponent(deploymentId)}`),
  operation: (repoId: string, operationId: string) => inPage(`${repoHash(repoId)}/op/${encodeURIComponent(operationId)}`),
}

export function navigate(href: string) {
  window.location.assign(href)
}

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

function getHash() {
  return window.location.hash
}

/** Route courante, recalculée à chaque changement de hash. */
export function useRoute(): Route {
  return parseHash(useSyncExternalStore(subscribe, getHash))
}
