import type { AlertSeverity, NpmSeverity, Repo } from '@shared/schemas/model.schema'
import { ALERT_SEVERITIES } from '@shared/schemas/model.schema'

/** Durée écoulée depuis `iso`, en français court : « à l'instant », « il y a 5 min ». */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return "à l'instant"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  return `il y a ${Math.round(hours / 24)} j`
}

/** `n` suivi du nom au singulier ou au pluriel. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`
}

export const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  critical: 'Critique',
  high: 'Haute',
  medium: 'Moyenne',
  low: 'Faible',
}

/** Gravité d'alerte correspondant à une gravité npm (`moderate` → `medium`, `info` → `low`). */
export function fromNpmSeverity(severity: NpmSeverity): AlertSeverity {
  if (severity === 'moderate') return 'medium'
  if (severity === 'info') return 'low'
  return severity
}

/** Gravité la plus haute des alertes ouvertes d'un dépôt, ou null sans alerte. */
export function worstSeverity(repo: Repo): AlertSeverity | null {
  for (const severity of ALERT_SEVERITIES) {
    if (repo.alerts.some((alert) => alert.severity === severity)) return severity
  }
  return null
}

/** Alertes ouvertes d'un ensemble de dépôts : leur nombre et la gravité la plus haute, null sans alerte. */
export function alertTotals(repos: Repo[]): { count: number; worst: AlertSeverity | null } {
  const worst = ALERT_SEVERITIES.find((severity) => repos.some((repo) => repo.alerts.some((alert) => alert.severity === severity))) ?? null
  return { count: repos.reduce((total, repo) => total + repo.alerts.length, 0), worst }
}

/** Préfixe d'un projet npm du dépôt : `""` pour la racine, `gui/` pour le dossier `gui`. */
export function projectPrefix(project: string): string {
  return project === '' ? '' : `${project}/`
}

/** Jour et heure locaux d'un instant ISO : « 28/10 à 14:32 ». */
export function dayAndTime(iso: string): string {
  const date = new Date(iso)
  const day = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  return `${day} à ${time}`
}

/** Heure locale `HH:MM:SS` d'un instant ISO. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
