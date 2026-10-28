import { ALERT_SEVERITIES, type Alert, type AlertSeverity, type NpmSeverity, type Repo } from "./schemas/model.schema.js";

/** Alertes ouvertes que l'utilisateur n'a pas marquées corrigées à la main. */
export function pendingAlerts(repo: Repo): Alert[] {
  const handled = new Set(repo.handledAlerts.map((mark) => mark.number));
  return repo.alerts.filter((alert) => !handled.has(alert.number));
}

/** Alertes ouvertes marquées corrigées à la main. */
export function handledAlerts(repo: Repo): Alert[] {
  const handled = new Set(repo.handledAlerts.map((mark) => mark.number));
  return repo.alerts.filter((alert) => handled.has(alert.number));
}

/** Gravité d'alerte correspondant à une gravité npm (`moderate` → `medium`, `info` → `low`). */
export function fromNpmSeverity(severity: NpmSeverity): AlertSeverity {
  if (severity === "moderate") return "medium";
  if (severity === "info") return "low";
  return severity;
}

/** Gravité la plus haute d'une liste, ou null si elle est vide. */
export function worstOf(severities: AlertSeverity[]): AlertSeverity | null {
  return ALERT_SEVERITIES.find((severity) => severities.includes(severity)) ?? null;
}
