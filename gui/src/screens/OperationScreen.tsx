import type { Operation, StepName, StepState, Vulnerability } from '@shared/schemas/model.schema'
import { ACTIVE_STATUSES } from '@shared/schemas/model.schema'
import { useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { usePolling } from '../hooks/usePolling'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { clockTime, fromNpmSeverity, plural, projectPrefix, SEVERITY_LABELS } from '../utils/format'
import { hrefs } from '../utils/router'

/** Relecture rapide pendant l'opération ; plus aucune une fois terminée. */
const ACTIVE_POLL_MS = 1000

const STEP_LABELS: Record<StepName, { text: string; mono: boolean }> = {
  clone: { text: 'Cloner le dépôt', mono: false },
  audit: { text: 'npm audit', mono: true },
  fix: { text: 'npm audit fix', mono: true },
  force: { text: 'npm audit fix --force', mono: true },
  push: { text: 'Commit et push', mono: false },
}

const STEP_ICONS: Record<StepState, IconName> = {
  pending: 'circle',
  running: 'loader-circle',
  done: 'circle-check',
  skipped: 'circle-minus',
  failed: 'circle-x',
}

const STATUS_SUFFIX: Partial<Record<Operation['status'], string>> = {
  done: 'terminée',
  failed: 'échouée',
  cancelled: 'annulée',
}

function isActive(operation: Operation): boolean {
  return ACTIVE_STATUSES.includes(operation.status)
}

/** Vulnérabilités corrigées entre deux audits, en clair. */
function fixedText(before: number | null, after: number | null): string | null {
  if (before === null || after === null) return null
  const fixed = before - after
  return fixed > 0 ? plural(fixed, 'corrigée') : 'aucune corrigée'
}

/** Vulnérabilités restantes pour lesquelles npm ne propose aucune version corrigée. */
function unfixable(operation: Operation): Vulnerability[] {
  return operation.remaining.filter((vulnerability) => vulnerability.fix === 'none')
}

/** Étape qui porte les vulnérabilités sans correctif : le dernier audit exécuté. */
function lastAuditedStep(operation: Operation): StepName | null {
  return (['force', 'fix', 'audit'] as const).find((step) => operation.steps[step] === 'done') ?? null
}

/** Pourquoi une étape a été passée : décision de l'utilisateur, ou rien à faire. */
function skippedReason(operation: Operation, step: StepName): string {
  if (operation.status === 'cancelled' || operation.steps.fix !== 'done') return 'ignorée'
  if (step === 'force' && operation.forceCandidates.length === 0) {
    return operation.counts.afterFix === 0 ? 'rien à corriger' : 'aucune correction possible'
  }
  if (step === 'push' && operation.changes.length === 0) return 'rien à pousser'
  return 'ignorée'
}

/** Résumé d'une étape terminée, aligné à droite de sa ligne. */
function stepResult(operation: Operation, step: StepName): ReactNode {
  const state = operation.steps[step]
  if (state === 'skipped') return skippedReason(operation, step)
  if (state !== 'done') return null
  const { initial, afterFix, afterForce } = operation.counts
  switch (step) {
    case 'audit':
      return initial === null ? null : plural(initial, 'vulnérabilité')
    case 'fix':
      return fixedText(initial, afterFix)
    case 'force':
      return fixedText(afterFix, afterForce)
    case 'push':
      return operation.pullRequest ? (
        <a className="link" href={operation.pullRequest.url} target="_blank" rel="noreferrer">
          Pull request #{operation.pullRequest.number}
        </a>
      ) : null
    default:
      return null
  }
}

function ChangesList({ operation }: { operation: Operation }) {
  return (
    <ul className="changes mono">
      {operation.changes.map((change) => (
        <li key={`${change.project}/${change.name}`}>
          {projectPrefix(change.project)}
          {change.name} <span className="muted">{change.from ?? 'ajouté'} → {change.to ?? 'retiré'}</span>
        </li>
      ))}
    </ul>
  )
}

/** Décision sur `npm audit fix --force` : les montées majeures en jeu, appliquer ou passer. */
function ForceDecision({ operation, onDone }: { operation: Operation; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const count = operation.forceCandidates.reduce((total, candidate) => total + candidate.vulnerabilities, 0)

  async function decide(apply: boolean) {
    setBusy(true)
    try {
      await api.decideForce(operation.id, apply)
      onDone()
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  return (
    <div className="step-body">
      <p className="muted">
        {count > 1 ? `${count} vulnérabilités nécessitent` : 'Une vulnérabilité nécessite'} une version majeure :
      </p>
      <ul className="candidates mono">
        {operation.forceCandidates.map((candidate) => (
          <li key={`${candidate.project}/${candidate.name}`}>
            {projectPrefix(candidate.project)}
            {candidate.name} {candidate.from ?? '?'} → {candidate.to}
          </li>
        ))}
      </ul>
      <div className="step-actions">
        <button type="button" className="button button-primary" disabled={busy} onClick={() => void decide(true)}>
          Appliquer --force
        </button>
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => void decide(false)}>
          Passer
        </button>
      </div>
    </div>
  )
}

/** Push : message de commit, branche, changements repliés et bouton principal. */
function PushForm({ operation, onDone }: { operation: Operation; onDone: () => void }) {
  const [message, setMessage] = useState(operation.commitMessage)
  const [showChanges, setShowChanges] = useState(false)
  const [busy, setBusy] = useState(false)

  async function push() {
    if (message.trim() === '') return
    setBusy(true)
    try {
      await api.push(operation.id, message.trim())
      onDone()
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  return (
    <div className="step-body">
      <input className="input mono commit-input" value={message} onChange={(event) => setMessage(event.target.value)} aria-label="Message de commit" spellCheck={false} />
      <p className="hint">
        Nouvelle branche {operation.branch} ·{' '}
        <button type="button" className="link" onClick={() => setShowChanges(!showChanges)}>
          {showChanges ? 'masquer les changements' : 'voir les changements'}
        </button>
      </p>
      {showChanges && <ChangesList operation={operation} />}
      <div className="step-actions">
        <button type="button" className="button button-primary" disabled={busy || message.trim() === ''} onClick={() => void push()}>
          <Icon name="upload" />
          Pousser et ouvrir la PR
        </button>
      </div>
    </div>
  )
}

/** Paquets vulnérables sans version corrigée, avec leur gravité. */
function UnfixableList({ vulnerabilities }: { vulnerabilities: Vulnerability[] }) {
  return (
    <div className="step-body">
      <ul className="changes mono">
        {vulnerabilities.map((vulnerability) => (
          <li key={`${vulnerability.project}/${vulnerability.name}`}>
            {projectPrefix(vulnerability.project)}
            {vulnerability.name} <span className="muted">{SEVERITY_LABELS[fromNpmSeverity(vulnerability.severity)].toLowerCase()}</span>
          </li>
        ))}
      </ul>
      <p className="hint">Aucune version corrigée n'est publiée sur le registre npm : la mise à jour est à faire à la main.</p>
    </div>
  )
}

function StepRow({ operation, step, onDone }: { operation: Operation; step: StepName; onDone: () => void }) {
  const [showUnfixable, setShowUnfixable] = useState(false)
  const state = operation.steps[step]
  const waitingHere = (operation.status === 'waiting_force' && step === 'force') || (operation.status === 'waiting_push' && step === 'push')
  const failedHere = state === 'failed' && operation.error
  const label = STEP_LABELS[step]
  const icon: IconName = waitingHere ? (step === 'force' ? 'circle-alert' : 'circle-dot') : STEP_ICONS[state]
  const withoutFix = lastAuditedStep(operation) === step ? unfixable(operation) : []

  return (
    <div className={`step step-${state}${waitingHere ? ' step-current' : ''}`}>
      <div className="step-line">
        <Icon name={icon} className={`step-icon${state === 'running' ? ' spin' : ''}${waitingHere && step === 'force' ? ' text-warning' : ''}`} />
        <span className={`step-label${label.mono ? ' mono' : ''}`}>{label.text}</span>
        <span className="step-result">
          {stepResult(operation, step)}
          {withoutFix.length > 0 && (
            <>
              {' · '}
              <button type="button" className="unfixable-toggle" aria-expanded={showUnfixable} onClick={() => setShowUnfixable(!showUnfixable)}>
                {plural(withoutFix.length, 'sans correctif', 'sans correctif')}
              </button>
            </>
          )}
        </span>
      </div>
      {showUnfixable && withoutFix.length > 0 && <UnfixableList vulnerabilities={withoutFix} />}
      {operation.status === 'waiting_force' && step === 'force' && <ForceDecision operation={operation} onDone={onDone} />}
      {operation.status === 'waiting_push' && step === 'push' && <PushForm key={operation.id} operation={operation} onDone={onDone} />}
      {failedHere && <p className="step-body error-text pre">{operation.error}</p>}
    </div>
  )
}

/** Écran d'une opération : ses étapes, la seule étape en cours dépliée, et le journal à la demande. */
export function OperationScreen({ repoId, operationId }: { repoId: string; operationId: string }) {
  const [interval, setIntervalMs] = useState<number | null>(ACTIVE_POLL_MS)
  const polled = usePolling(`operation:${operationId}`, () => api.getOperation(operationId), interval)
  const [showLog, setShowLog] = useState(false)
  const operation = polled.data?.operation ?? null

  if (operation && !isActive(operation) && interval !== null) setIntervalMs(null)

  if (!operation) {
    return (
      <div className="page">
        <p className={polled.error ? 'error-text' : 'muted'}>{polled.error ?? "Chargement de l'opération…"}</p>
      </div>
    )
  }

  const name = repoId.split('/')[1]
  const suffix = STATUS_SUFFIX[operation.status]
  const steps: StepName[] = operation.kind === 'audit' ? ['clone', 'audit'] : ['clone', 'audit', 'fix', 'force', 'push']

  async function cancel() {
    try {
      await api.cancel(operationId)
      polled.reload()
    } catch (err) {
      showError(err)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <a className="back" href={hrefs.repo(repoId)} aria-label="Retour au dépôt">
          <Icon name="arrow-left" size={20} />
        </a>
        <div className="page-head-text">
          <h1 className="page-title">
            {operation.kind === 'audit' ? 'Audit' : 'Correction'} de {name}
          </h1>
          <p className="subtitle">
            Lancée par {operation.origin === 'agent' ? "l'agent" : 'vous'} · clone temporaire de {operation.baseBranch}
            {suffix && ` · ${suffix}`}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className={`button button-ghost${showLog ? ' is-active' : ''}`} onClick={() => setShowLog(!showLog)}>
            <Icon name="square-terminal" />
            Journal
          </button>
          {isActive(operation) && (
            <button type="button" className="button button-secondary" onClick={() => void cancel()} disabled={operation.cancelRequested}>
              {operation.cancelRequested ? 'Annulation…' : 'Annuler'}
            </button>
          )}
        </div>
      </div>

      <div className="panel steps">
        {steps.map((step) => (
          <StepRow key={step} operation={operation} step={step} onDone={polled.reload} />
        ))}
      </div>

      {operation.error && !Object.values(operation.steps).includes('failed') && <p className="banner banner-error pre">{operation.error}</p>}

      {showLog && (
        <pre className="log mono">
          {operation.log.map((entry, index) => (
            <div key={index}>
              <span className="log-time">{clockTime(entry.at)}</span> {entry.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}
