import type { OperationSummary } from '@shared/schemas/api.schema'
import { ACTIVE_STATUSES } from '@shared/schemas/model.schema'
import type { ReactNode } from 'react'
import { dayAndTime, plural, SCOPE_LABELS } from '../utils/format'
import { hrefs } from '../utils/router'
import { Icon, type IconName } from './Icon'

/** Opérations conservées par dépôt, comme le serveur. */
export const KEPT_OPERATIONS = 20

const STATUS_TEXTS: Record<OperationSummary['status'], string> = {
  running: 'en cours',
  done: 'terminée',
  failed: 'échouée',
  cancelled: 'annulée',
}

function statusIcon(operation: OperationSummary): { icon: IconName; className: string } {
  if (ACTIVE_STATUSES.includes(operation.status)) return { icon: 'circle-dot', className: 'text-accent' }
  if (operation.status === 'done') return { icon: 'circle-check', className: 'text-ok' }
  if (operation.status === 'failed') return { icon: 'circle-x', className: 'error-text' }
  return { icon: 'circle-minus', className: 'muted' }
}

/** Vulnérabilités avant et après, `4 → 0 vulnérabilité` ; le début de l'erreur pour une opération échouée. */
function countsText(operation: OperationSummary): ReactNode {
  if (operation.status === 'failed' && operation.error) return <span className="error-text">{operation.error.split(/\r?\n/)[0]}</span>
  const { before, after } = operation
  if (before === null) return null
  if (operation.kind === 'audit' || after === null) return plural(before, 'vulnérabilité')
  return `${before} → ${plural(after, 'vulnérabilité')}`
}

/** Part de Claude : `Claude` quand il a été lancé pour corriger. */
function claudeText(operation: OperationSummary): string | null {
  return operation.claude ? 'Claude' : null
}

/** Issue de l'opération : la pull request ouverte, ou son statut. */
function outcome(operation: OperationSummary): ReactNode {
  if (operation.pullRequest) {
    return (
      <a className="pr-note" href={operation.pullRequest.url} target="_blank" rel="noreferrer">
        PR #{operation.pullRequest.number}
      </a>
    )
  }
  return <span className={operation.status === 'failed' ? 'error-text' : undefined}>{STATUS_TEXTS[operation.status]}</span>
}

/** Historique d'un dépôt : une ligne par opération, de la plus récente à la plus ancienne ; chaque ligne ouvre l'opération. */
export function OperationHistory({ repoId, operations }: { repoId: string; operations: OperationSummary[] }) {
  if (operations.length === 0) {
    return (
      <div className="panel empty">
        <p>Aucune opération sur ce dépôt.</p>
      </div>
    )
  }
  return (
    <>
      <div className="panel list">
        {operations.map((operation) => {
          const status = statusIcon(operation)
          const claude = claudeText(operation)
          return (
            <div key={operation.id} className="row row-linked history-row">
              <Icon name={status.icon} className={`history-icon ${status.className}`} />
              <div className="history-title">
                <a className="row-link" href={hrefs.operation(repoId, operation.id)}>
                  {operation.kind === 'audit' ? 'Audit' : 'Correction'}
                </a>
                <span className="history-meta">
                  {operation.origin === 'agent' ? "l'agent" : 'vous'} · {operation.scope === 'production' ? 'production' : SCOPE_LABELS.all} · {operation.baseBranch}
                </span>
              </div>
              <span className="history-date">{dayAndTime(operation.createdAt)}</span>
              <span className="history-counts">{countsText(operation)}</span>
              <span className="history-claude">
                {claude && (
                  <>
                    <Icon name="sparkles" size={14} />
                    {claude}
                  </>
                )}
              </span>
              <span className="history-outcome">{outcome(operation)}</span>
              <Icon name="chevron-right" className="row-chevron" />
            </div>
          )
        })}
      </div>
      <p className="hint history-note">Les {KEPT_OPERATIONS} dernières opérations du dépôt sont conservées.</p>
    </>
  )
}
