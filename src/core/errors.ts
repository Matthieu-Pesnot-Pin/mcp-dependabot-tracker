/** Erreur métier dont le message s'adresse directement à l'agent ou à la GUI. */
export class TrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerError";
  }
}

/** Dépôt ou opération introuvable. */
export class NotFoundError extends TrackerError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Action refusée par l'état courant : opération déjà en cours, étape qui n'attend pas cette décision. */
export class ConflictError extends TrackerError {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
