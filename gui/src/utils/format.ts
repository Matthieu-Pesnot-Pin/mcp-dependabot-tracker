import { pendingAlerts, worstOf } from '@shared/alerts'
import type { RepoView } from '@shared/schemas/api.schema'
import type { Alert, AlertSeverity, Repo } from '@shared/schemas/model.schema'
import { ALERT_SEVERITIES } from '@shared/schemas/model.schema'

export { fromNpmSeverity } from '@shared/alerts'

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

/** Gravité la plus haute d'un ensemble d'alertes, ou null sans alerte. */
export function worstSeverity(alerts: Alert[]): AlertSeverity | null {
  return ALERT_SEVERITIES.find((severity) => alerts.some((alert) => alert.severity === severity)) ?? null
}

/**
 * Vulnérabilités d'un ensemble de dépôts : les alertes non corrigées à la main,
 * plus celles que le dernier audit a trouvées là où Dependabot ne signale rien.
 * Leur nombre et la gravité la plus haute, null sans vulnérabilité.
 */
export function alertTotals(views: RepoView[]): { count: number; worst: AlertSeverity | null } {
  const alerts = views.flatMap((view) => pendingAlerts(view.repo))
  const findings = views.flatMap((view) => (view.auditFindings ? [view.auditFindings] : []))
  return {
    count: alerts.length + findings.reduce((total, finding) => total + finding.count, 0),
    worst: worstOf([...alerts.map((alert) => alert.severity), ...findings.map((finding) => finding.severity)]),
  }
}

/** Nombre de pull requests du tracker en attente dans un ensemble de dépôts. */
export function pullRequestCount(repos: Repo[]): number {
  return repos.reduce((total, repo) => total + repo.pullRequests.length, 0)
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
