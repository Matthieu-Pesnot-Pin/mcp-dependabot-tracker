import type { AuditAllState } from "../../shared/schemas/api.schema.js";
import type { Operation } from "../../shared/schemas/model.schema.js";
import { ConflictError } from "./errors.js";

/** Audits menés en même temps par « Auditer tout ». */
export const AUDIT_ALL_CONCURRENCY = 3;

/**
 * Audit de tous les dépôts suivis, lancé depuis la GUI : `AUDIT_ALL_CONCURRENCY`
 * audits à la fois. Un dépôt dont une opération est déjà en cours est laissé de
 * côté. Une seule série à la fois dans ce processus.
 */
export class AuditAll {
  private state: AuditAllState | null = null;
  private run: Promise<void> = Promise.resolve();

  constructor(
    private readonly audit: (repoId: string) => Promise<Operation>,
    private readonly logError: (message: string) => void
  ) {}

  /** État de la dernière série, null si aucune n'a été lancée. */
  status(): AuditAllState | null {
    return this.state && { ...this.state, skipped: [...this.state.skipped], failed: [...this.state.failed] };
  }

  /** Lance la série sur `repoIds` et rend aussitôt son état ; refusé si une série est en cours. */
  start(repoIds: string[]): AuditAllState {
    if (this.state?.running) throw new ConflictError("An audit of every repository is already running.");
    this.state = { running: true, startedAt: new Date().toISOString(), finishedAt: null, total: repoIds.length, done: 0, skipped: [], failed: [] };
    this.run = this.auditAll(this.state, [...repoIds]);
    return this.status()!;
  }

  /** Attend la fin de la série en cours. */
  finished(): Promise<void> {
    return this.run;
  }

  private async auditAll(state: AuditAllState, queue: string[]): Promise<void> {
    const worker = async () => {
      for (let repoId = queue.shift(); repoId !== undefined; repoId = queue.shift()) await this.auditOne(state, repoId);
    };
    await Promise.all(Array.from({ length: Math.min(AUDIT_ALL_CONCURRENCY, queue.length) }, worker));
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }

  private async auditOne(state: AuditAllState, repoId: string): Promise<void> {
    try {
      const operation = await this.audit(repoId);
      if (operation.status !== "done") state.failed.push({ repoId, error: operation.error ?? operation.status });
    } catch (err: any) {
      if (err instanceof ConflictError) {
        state.skipped.push(repoId);
      } else {
        state.failed.push({ repoId, error: err?.message ?? String(err) });
        this.logError(`Audit of ${repoId} could not run: ${err?.stack ?? err}`);
      }
    } finally {
      state.done += 1;
    }
  }
}
