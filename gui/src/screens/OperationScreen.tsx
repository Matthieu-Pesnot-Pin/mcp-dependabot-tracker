import type { Operation, Repair, StepName, StepState, Vulnerability } from '@shared/schemas/model.schema'
import { ACTIVE_STATUSES } from '@shared/schemas/model.schema'
import { useState, type ReactNode } from 'react'
import { ClaudeSession } from '../components/ClaudeSession'
import { Icon, type IconName } from '../components/Icon'
import { MergedActions } from '../components/MergedActions'
import { usePolling } from '../hooks/usePolling'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { clockTime, fromNpmSeverity, plural, projectPrefix, SCOPE_LABELS, SEVERITY_LABELS } from '../utils/format'
import { hrefs } from '../utils/router'

/** Relecture rapide pendant l'opération ; plus aucune une fois terminée. */
const ACTIVE_POLL_MS = 1000

/** Relecture de l'historique du dépôt, pour passer d'une opération à l'autre. */
const HISTORY_POLL_MS = 10_000

/** Onglets de l'écran d'une opération. */
type OperationTab = 'steps' | 'claude' | 'log'

const STEP_LABELS: Record<StepName, { text: string; mono: boolean }> = {
  clone: { text: 'Cloner le dépôt', mono: false },
  audit: { text: 'npm audit', mono: true },
  fix: { text: 'npm audit fix', mono: true },
  repair: { text: 'Corrections par Claude', mono: false },
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
  return (['repair', 'fix', 'audit'] as const).find((step) => operation.steps[step] === 'done') ?? null
}

/** Pourquoi une étape a été passée : rien à faire, ou opération arrêtée avant. */
function skippedReason(operation: Operation, step: StepName): string {
  if (operation.status === 'cancelled' || operation.steps.fix !== 'done') return 'ignorée'
  if (step === 'repair' && operation.counts.afterFix === 0) return 'rien à corriger'
  if (step === 'push' && operation.changes.length === 0 && !operation.repair?.commit) return 'rien à pousser'
  return 'ignorée'
}

/** Durée d'une session de Claude en cours et tours écoulés : `2 min · 14 tours`. */
function sessionProgress(session: { startedAt: string; turns: number }): string {
  const minutes = Math.floor((Date.now() - Date.parse(session.startedAt)) / 60_000)
  return `${minutes < 1 ? "moins d'une minute" : `${minutes} min`} · ${plural(session.turns, 'tour')}`
}

/** Résultat des corrections par Claude : vulnérabilités corrigées et fichiers modifiés. */
function repairResult(operation: Operation, repair: Repair): string | null {
  if (!repair.report) return null
  const fixed = fixedText(operation.counts.afterFix, operation.counts.afterRepair)
  const files = repair.report.changes.length
  return [fixed, files > 0 ? plural(files, 'fichier modifié', 'fichiers modifiés') : 'aucun fichier modifié'].filter(Boolean).join(' · ')
}

/** Résumé d'une étape terminée, aligné à droite de sa ligne. */
function stepResult(operation: Operation, step: StepName): ReactNode {
  const state = operation.steps[step]
  if (step === 'repair' && state === 'running' && operation.repair) return sessionProgress(operation.repair)
  if (state === 'skipped') return skippedReason(operation, step)
  if (step === 'repair' && state === 'failed') return 'échouées · corrections de npm audit fix seules'
  if (state !== 'done') return null
  const { initial, afterFix } = operation.counts
  switch (step) {
    case 'audit':
      return initial === null ? null : plural(initial, 'vulnérabilité')
    case 'fix':
      return fixedText(initial, afterFix)
    case 'repair':
      return operation.repair ? (
        <>
          {repairResult(operation, operation.repair)}
          {operation.repair.task && (
            <>
              {' · '}
              <a className="link task-link" href={operation.repair.task.url} target="_blank" rel="noreferrer" title={operation.repair.task.title}>
                <span className="task-link-text">Rapport {operation.repair.task.key}</span>
                <Icon name="external-link" size={14} />
              </a>
            </>
          )}
        </>
      ) : null
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

/** Dernières actions de Claude pendant la session, la plus récente en clair. */
function ClaudeActivity({ activity, hint }: { activity: string[]; hint: string }) {
  return (
    <div className="step-body">
      <ul className="activity mono">
        {activity.map((line, index) => (
          <li key={`${index}-${line}`} className={index === activity.length - 1 ? 'activity-last' : undefined}>
            {line}
          </li>
        ))}
      </ul>
      <p className="hint">{hint}</p>
    </div>
  )
}

const TEST_ICONS: Record<'passed' | 'failed' | 'not_run', { icon: IconName; className: string }> = {
  passed: { icon: 'circle-check', className: 'text-ok' },
  failed: { icon: 'circle-x', className: 'error-text' },
  not_run: { icon: 'circle-minus', className: 'muted' },
}

/** Ce que Claude a changé : résumé, fichiers, tests, audit et lien vers la tâche du rapport. */
function RepairSummary({ operation, repair }: { operation: Operation; repair: Repair }) {
  const report = repair.report!
  const tests = TEST_ICONS[report.tests.outcome]
  const remaining = operation.counts.afterRepair
  return (
    <div className="step-body">
      <div className="verdict repair-summary">
        <p className="verdict-title">
          <Icon name="sparkles" size={14} />
          Ce que Claude a changé
        </p>
        <p className="verdict-text">{report.summary}</p>
        {report.changes.length > 0 && (
          <ul className="repair-changes">
            {report.changes.map((change) => (
              <li key={change.file}>
                <span className="mono">{change.file}</span>
                <span className="muted">{change.change}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="repair-line">
          <Icon name={tests.icon} size={12} className={tests.className} />
          {report.tests.outcome === 'not_run' ? 'Tests non lancés' : report.tests.outcome === 'passed' ? 'Tests réussis' : 'Tests en échec'} — {report.tests.detail}
        </p>
        <p className="repair-line">
          <Icon name={remaining === 0 ? 'circle-check' : 'circle-alert'} size={12} className={remaining === 0 ? 'text-ok' : 'text-warning'} />
          npm audit après corrections : {remaining === null ? 'non relancé' : remaining === 0 ? 'aucune vulnérabilité' : plural(remaining, 'vulnérabilité')}
          {repair.task && (
            <>
              {' · '}
              <a className="link task-link" href={repair.task.url} target="_blank" rel="noreferrer">
                rapport {repair.task.key}
                <Icon name="external-link" size={12} />
              </a>
            </>
          )}
        </p>
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

/**
 * Suite d'une correction poussée : la branche et ses changements, puis, tant
 * que la pull request attend dans « PR en attente », la marquer fusionnée,
 * avec ou sans passage « à déployer ».
 */
function PushedInfo({ operation }: { operation: Operation }) {
  const polled = usePolling(`repo:${operation.repoId}`, () => api.getRepo(operation.repoId), null)
  const [showChanges, setShowChanges] = useState(false)
  const repo = polled.data?.repo
  const pending = repo !== undefined && repo.deprecatedAt === null && repo.pullRequests.some((pull) => pull.number === operation.pullRequest?.number)

  return (
    <div className="step-body">
      <p className="hint">
        Branche {operation.branch} ·{' '}
        <button type="button" className="link" onClick={() => setShowChanges(!showChanges)}>
          {showChanges ? 'masquer les changements' : 'voir les changements'}
        </button>
      </p>
      {showChanges && <ChangesList operation={operation} />}
      {pending && (
        <div className="merged-offer">
          <Icon name="git-pull-request" className="merged-offer-icon" />
          <span className="merged-offer-text">
            La pull request attend dans « <a className="link" href={hrefs.pulls()}>PR en attente</a> ».
          </span>
          <MergedActions repoId={operation.repoId} onDone={polled.reload} />
        </div>
      )}
    </div>
  )
}

function StepRow({ operation, step }: { operation: Operation; step: StepName }) {
  const [showUnfixable, setShowUnfixable] = useState(false)
  const state = operation.steps[step]
  const failure = step === 'repair' ? (operation.repair?.error ?? null) : operation.error
  const failedHere = state === 'failed' && failure
  const label = STEP_LABELS[step]
  const withoutFix = lastAuditedStep(operation) === step ? unfixable(operation) : []

  return (
    <div className={`step step-${state}`}>
      <div className="step-line">
        <Icon name={STEP_ICONS[state]} className={`step-icon${state === 'running' ? ' spin' : ''}`} />
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
      {step === 'repair' && state === 'running' && operation.repair && (
        <ClaudeActivity activity={operation.repair.activity} hint="Claude analyse et corrige ; son rapport arrive dans l'organizer à la fin de la session." />
      )}
      {step === 'repair' && state === 'done' && operation.repair?.report && <RepairSummary operation={operation} repair={operation.repair} />}
      {step === 'push' && state === 'done' && operation.pullRequest && <PushedInfo operation={operation} />}
      {failedHere && <p className="step-body error-text pre">{failure}</p>}
    </div>
  )
}

/** Passage d'une opération du dépôt à l'autre : position dans l'historique, la plus récente à gauche. */
function OperationPager({ repoId, operationId }: { repoId: string; operationId: string }) {
  const history = usePolling(`history:${repoId}`, () => api.listOperations(repoId), HISTORY_POLL_MS)
  const operations = history.data?.operations ?? []
  const index = operations.findIndex((candidate) => candidate.id === operationId)
  if (index === -1) return null
  const newer = operations[index - 1]
  const older = operations[index + 1]
  return (
    <div className="pager">
      <a className={`pager-arrow${newer ? '' : ' is-disabled'}`} href={newer ? hrefs.operation(repoId, newer.id) : undefined} aria-label="Opération plus récente" title="Opération plus récente">
        <Icon name="chevron-left" size={16} />
      </a>
      <span className="pager-position">
        {index + 1} / {operations.length}
      </span>
      <a className={`pager-arrow${older ? '' : ' is-disabled'}`} href={older ? hrefs.operation(repoId, older.id) : undefined} aria-label="Opération plus ancienne" title="Opération plus ancienne">
        <Icon name="chevron-right" size={16} />
      </a>
    </div>
  )
}

/**
 * Écran d'une opération en trois onglets : ses étapes, la seule étape en cours
 * dépliée ; la session de Claude ; le journal. Les flèches passent aux autres
 * opérations du dépôt.
 */
export function OperationScreen({ repoId, operationId }: { repoId: string; operationId: string }) {
  const [interval, setIntervalMs] = useState<number | null>(ACTIVE_POLL_MS)
  const polled = usePolling(`operation:${operationId}`, () => api.getOperation(operationId), interval)
  const [tab, setTab] = useState<OperationTab>('steps')
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
  const steps: StepName[] =
    operation.kind === 'audit'
      ? ['clone', 'audit']
      : ['clone', 'audit', 'fix', 'repair', 'push']

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
        <a className="back" href={hrefs.repoHistory(repoId)} aria-label="Retour à l'historique du dépôt">
          <Icon name="arrow-left" size={20} />
        </a>
        <div className="page-head-text">
          <h1 className="page-title">
            {operation.kind === 'audit' ? 'Audit' : 'Correction'} de {name}
          </h1>
          <p className="subtitle">
            Lancée par {operation.origin === 'agent' ? "l'agent" : 'vous'} · clone temporaire de {operation.baseBranch} · {SCOPE_LABELS[operation.scope]}
            {suffix && ` · ${suffix}`}
          </p>
        </div>
        <div className="page-actions">
          <OperationPager repoId={repoId} operationId={operationId} />
          {isActive(operation) && (
            <button type="button" className="button button-secondary" onClick={() => void cancel()} disabled={operation.cancelRequested}>
              {operation.cancelRequested ? 'Annulation…' : 'Annuler'}
            </button>
          )}
        </div>
      </div>

      <nav className="tabs">
        <button type="button" className={`tab${tab === 'steps' ? ' is-active' : ''}`} onClick={() => setTab('steps')}>
          Étapes
        </button>
        {operation.repair && (
          <button type="button" className={`tab${tab === 'claude' ? ' is-active' : ''}`} onClick={() => setTab('claude')}>
            Claude
          </button>
        )}
        <button type="button" className={`tab${tab === 'log' ? ' is-active' : ''}`} onClick={() => setTab('log')}>
          Journal
        </button>
      </nav>

      {tab === 'steps' && (
        <>
          <div className="panel steps">
            {steps.map((step) => (
              <StepRow key={step} operation={operation} step={step} />
            ))}
          </div>
          {operation.error && !Object.values(operation.steps).includes('failed') && <p className="banner banner-error pre">{operation.error}</p>}
        </>
      )}

      {tab === 'claude' && operation.repair && <ClaudeSession operation={operation} repair={operation.repair} active={isActive(operation)} />}

      {tab === 'log' && (
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
