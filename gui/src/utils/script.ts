/** Nombre de lignes d'un script ; un script vide en a une. */
export function lineCount(script: string): number {
  return script.split('\n').length
}
