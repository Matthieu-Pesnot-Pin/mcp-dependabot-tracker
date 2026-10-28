import type { Alert, Repo } from "./schemas/model.schema.js";

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
