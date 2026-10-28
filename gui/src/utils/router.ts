import { useSyncExternalStore } from 'react'

/**
 * Écran désigné par le hash de l'URL :
 *   `#/`                                accueil (dépôts suivis) ;
 *   `#/r/<propriétaire>/<nom>`          écran du dépôt ;
 *   `#/r/<propriétaire>/<nom>/op/<id>`  écran d'une opération.
 */
export type Route =
  | { name: 'home' }
  | { name: 'repo'; repoId: string }
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
  if (segments.length === 0) return { name: 'home' }
  if (segments.some((segment) => segment === null)) return { name: 'not_found', hash }
  const [section, owner, name, sub, operationId] = segments as string[]
  if (section !== 'r' || !owner || !name) return { name: 'not_found', hash }
  const repoId = `${owner}/${name}`
  if (segments.length === 3) return { name: 'repo', repoId }
  if (segments.length === 5 && sub === 'op') return { name: 'operation', repoId, operationId }
  return { name: 'not_found', hash }
}

/**
 * Adresse de la page courante suivie de `hash`. Un lien `#/…` seul serait
 * résolu contre le `<base href>`, qui diffère de l'adresse de la page quand un
 * relais (gateway manager, `/_gui/…`) la sert sous un autre chemin.
 */
function inPage(hash: string): string {
  return `${window.location.pathname}${window.location.search}${hash}`
}

function repoHash(repoId: string): string {
  const [owner, name] = repoId.split('/')
  return `#/r/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

export const hrefs = {
  home: () => inPage('#/'),
  repo: (repoId: string) => inPage(repoHash(repoId)),
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
