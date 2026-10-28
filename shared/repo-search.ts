/** Nombre maximal de suggestions affichées sous le champ d'ajout d'un dépôt. */
export const MAX_SUGGESTIONS = 10;

/**
 * Dépôts dont le nom complet contient `query`, sans tenir compte de la casse :
 * d'abord ceux dont le nom (après `propriétaire/`) commence par la recherche,
 * puis les autres, chacun dans l'ordre alphabétique ; au plus `limit`.
 * Une recherche vide ne propose rien.
 */
export function searchRepositories(repositories: string[], query: string, limit = MAX_SUGGESTIONS): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const startsWith: string[] = [];
  const contains: string[] = [];
  for (const repository of repositories) {
    const full = repository.toLowerCase();
    if (!full.includes(needle)) continue;
    const name = full.slice(full.indexOf("/") + 1);
    (name.startsWith(needle) || full.startsWith(needle) ? startsWith : contains).push(repository);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  return [...startsWith.sort(byName), ...contains.sort(byName)].slice(0, limit);
}
