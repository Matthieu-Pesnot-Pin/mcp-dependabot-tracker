/** Longueur maximale d'un nom de tag, celle qu'accepte le serveur. */
export const MAX_TAG_LENGTH = 30

/** Tag connu de l'accueil et nombre de dépôts suivis qui le portent. */
export interface TagCount {
  name: string
  count: number
}

/** Deux noms désignent le même tag, sans tenir compte de la casse ni des espaces de bord. */
export function sameTag(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Tags des dépôts, chacun avec son nombre de dépôts, dans l'ordre alphabétique. */
export function countTags(repos: { tags: string[] }[]): TagCount[] {
  const counts = new Map<string, TagCount>()
  for (const repo of repos) {
    for (const tag of repo.tags) {
      const entry = counts.get(tag.toLowerCase())
      if (entry) entry.count += 1
      else counts.set(tag.toLowerCase(), { name: tag, count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
}
