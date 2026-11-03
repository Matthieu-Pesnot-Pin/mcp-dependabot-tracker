import type { AnalysisReport, Operation, Repair, StepName, StepState, Vulnerability } from '@shared/schemas/model.schema'
import { ACTIVE_STATUSES } from '@shared/schemas/model.schema'
import { useState, type ReactNode } from 'react'
import { ClaudeSessions } from '../components/ClaudeSessions'
import { Icon, type IconName } from '../components/Icon'
import { usePolling } from '../hooks/usePolling'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { clockTime, fromNpmSeverity, plural, projectPrefix, relativeTime, SCOPE_LABELS, SEVERITY_LABELS } from '../utils/format'
import { hrefs } from '../utils/router'

/** Relecture rapide pendant l'opération ; plus aucune une fois terminée. */
const ACTIVE_POLL_MS = 1000

/** Relecture de l'historique du dépôt, pour passer d'une opération à l'autre. */
const HISTORY_POLL_MS = 10_000

/** Onglets de l'écran d'une opération. */
type OperationTab = 'steps' | 'claude' | 'log'

/** Relecture des remarques de la tâche pendant que les corrections par Claude attendent. */
const REMARKS_POLL_MS = 10_000

const STEP_LABELS: Record<StepName, { text: string; mono: boolean }> = {
  clone: { text: 'Cloner le dépôt', mono: false },
  audit: { text: 'npm audit', mono: true },
  fix: { text: 'npm audit fix', mono: true },
  analysis: { text: 'Analyse par Claude', mono: false },
  force: { text: 'npm audit fix --force', mono: true },
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
  return (['force', 'fix', 'audit'] as const).find((step) => operation.steps[step] === 'done') ?? null
}

/** Pourquoi une étape a été passée : décision de l'utilisateur, ou rien à faire. */
function skippedReason(operation: Operation, step: StepName): string {
  if (operation.status === 'cancelled' || operation.steps.fix !== 'done') return 'ignorée'
  if (step === 'force' && operation.forceCandidates.length === 0) {
    return operation.counts.afterFix === 0 ? 'rien à corriger' : 'aucune correction possible'
  }
  if (step === 'force' && operation.analysis?.report && !operation.analysis.report.force.recommended) return 'passé · déconseillé par Claude'
  if (step === 'force') return 'passé'
  if (step === 'repair' && (operation.counts.afterForce ?? operation.counts.afterFix) === 0) return 'rien à corriger'
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
  const fixed = fixedText(operation.counts.afterForce ?? operation.counts.afterFix, operation.counts.afterRepair)
  const files = repair.report.changes.length
  return [fixed, files > 0 ? plural(files, 'fichier modifié', 'fichiers modifiés') : 'aucun fichier modifié'].filter(Boolean).join(' · ')
}

/** Résumé d'une étape terminée, aligné à droite de sa ligne. */
function stepResult(operation: Operation, step: StepName): ReactNode {
  const state = operation.steps[step]
  if (step === 'analysis' && state === 'running' && operation.analysis) return sessionProgress(operation.analysis)
  if (step === 'repair' && state === 'running' && operation.repair) return sessionProgress(operation.repair)
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
    case 'analysis':
      return operation.analysis?.task ? (
        <a className="link task-link" href={operation.analysis.task.url} target="_blank" rel="noreferrer" title={operation.analysis.task.title}>
          <span className="task-link-text">Tâche « {operation.analysis.task.title} »</span>
          <Icon name="external-link" size={14} />
        </a>
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

/** Dernières actions de Claude pendant une session, la plus récente en clair. */
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

/** Avis de Claude sur `--force`, et ce qu'il juge urgent de corriger à la main. */
function ClaudeVerdict({ report }: { report: AnalysisReport }) {
  return (
    <div className="verdict">
      <p className="verdict-title">
        <Icon name="sparkles" size={14} />
        {report.force.recommended ? 'Claude recommande le --force' : 'Claude déconseille le --force'}
      </p>
      <p className="verdict-text">{report.force.reason}</p>
      {report.urgent.length > 0 && (
        <ul className="verdict-urgent">
          {report.urgent.map((item) => (
            <li key={item.package}>
              <span className="mono">{item.package}</span> — {item.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Décision sur `npm audit fix --force` : les montées majeures en jeu, l'avis de Claude s'il a analysé, appliquer ou passer. */
function ForceDecision({ operation, onDone }: { operation: Operation; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const count = operation.forceCandidates.reduce((total, candidate) => total + candidate.vulnerabilities, 0)
  const report = operation.analysis?.report ?? null
  const skipFirst = report !== null && !report.force.recommended

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
      {report && <ClaudeVerdict report={report} />}
      <div className={`step-actions${skipFirst ? ' step-actions-reversed' : ''}`}>
        <button type="button" className={`button ${skipFirst ? 'button-secondary' : 'button-primary'}`} disabled={busy} onClick={() => void decide(true)}>
          Appliquer --force
        </button>
        <button type="button" className={`button ${skipFirst ? 'button-primary' : 'button-secondary'}`} disabled={busy} onClick={() => void decide(false)}>
          Passer
        </button>
      </div>
    </div>
  )
}

/**
 * Corrections par Claude en attente : les remarques laissées sur la tâche de
 * l'analyse, relues régulièrement, puis lancer les corrections ou passer.
 */
function RepairLauncher({ operation, onDone }: { operation: Operation; onDone: () => void }) {
  const remarks = usePolling(`remarks:${operation.id}`, () => api.getRemarks(operation.id), REMARKS_POLL_MS)
  const [busy, setBusy] = useState(false)
  const task = operation.analysis?.task ?? null
  const comments = remarks.data?.remarks ?? []

  async function decide(run: boolean) {
    setBusy(true)
    try {
      await api.decideRepair(operation.id, run)
      onDone()
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  return (
    <div className="step-body">
      <p className="muted">Claude relit la tâche et vos remarques, corrige le code ou force des versions dans le clone, lance les tests, puis fait un commit.</p>
      <div className="verdict remarks">
        <p className="remarks-head">
          <Icon name="message-square" size={14} />
          <span className="remarks-count">
            {remarks.error ? 'Remarques illisibles' : !remarks.data ? 'Lecture des remarques…' : comments.length === 0 ? 'Aucune remarque sur la tâche' : plural(comments.length, 'remarque sur la tâche', 'remarques sur la tâche')}
          </span>
          {task && (
            <a className="link task-link" href={task.url} target="_blank" rel="noreferrer">
              Commenter la tâche
              <Icon name="external-link" size={12} />
            </a>
          )}
        </p>
        {remarks.error && <p className="error-text remarks-note">{remarks.error}</p>}
        {remarks.data && comments.length === 0 && <p className="remarks-note">Sans remarque, Claude suit son analyse.</p>}
        {comments.length > 0 && (
          <ul className="remarks-list">
            {comments.map((comment, index) => (
              <li key={`${comment.createdAt}-${index}`}>
                <p className="remarks-body">{comment.body}</p>
                <p className="remarks-meta">
                  {comment.author} · {relativeTime(comment.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="step-actions">
        <button type="button" className="button button-primary" disabled={busy} onClick={() => void decide(true)}>
          <Icon name="sparkles" />
          Lancer les corrections
        </button>
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => void decide(false)}>
          {operation.changes.length > 0 ? 'Passer au push' : 'Passer'}
        </button>
      </div>
    </div>
  )
}

const TEST_ICONS: Record<'passed' | 'failed' | 'not_run', { icon: IconName; className: string }> = {
  passed: { icon: 'circle-check', className: 'text-ok' },
  failed: { icon: 'circle-x', className: 'error-text' },
  not_run: { icon: 'circle-minus', className: 'muted' },
}

/** Ce que Claude a changé : résumé, fichiers, tests, audit et lien vers la sous-tâche du rapport détaillé. */
function RepairSummary({ operation, repair }: { operation: Operation; repair: Repair }) {
  const report = repair.report!
  const tests = TEST_ICONS[report.tests.outcome]
  const remaining = operation.counts.afterRepair
  return (
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
              rapport détaillé {repair.task.key}
              <Icon name="external-link" size={12} />
            </a>
          </>
        )}
      </p>
    </div>
  )
}

/** Commits de la branche, en clair : `2 commits, dont celui de Claude`. */
function commitsText(repair: Repair): string {
  const count = (repair.auditCommit ? 1 : 0) + (repair.commit ? 1 : 0)
  if (!repair.commit) return plural(count, 'commit')
  return count === 1 ? 'le commit de Claude' : `${plural(count, 'commit')}, dont celui de Claude`
}

/**
 * Push : le rapport de Claude s'il a corrigé, le message de commit (titre de
 * la pull request quand les commits sont déjà faits), la branche, les
 * changements repliés et le bouton principal ; après Claude, le relancer.
 */
function PushForm({ operation, onDone }: { operation: Operation; onDone: () => void }) {
  const [message, setMessage] = useState(operation.commitMessage)
  const [showChanges, setShowChanges] = useState(false)
  const [busy, setBusy] = useState(false)
  const repair = operation.repair?.report ? operation.repair : null

  async function rerun() {
    setBusy(true)
    try {
      await api.decideRepair(operation.id, true)
      onDone()
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

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
      {repair && <RepairSummary operation={operation} repair={repair} />}
      <input
        className={`input mono commit-input${repair ? ' commit-input-spaced' : ''}`}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        aria-label={operation.repair ? 'Titre de la pull request' : 'Message de commit'}
        spellCheck={false}
      />
      <p className="hint">
        Nouvelle branche {operation.branch}
        {operation.repair && ` · ${commitsText(operation.repair)}`} ·{' '}
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
        {repair && (
          <button type="button" className="button button-secondary" disabled={busy} onClick={() => void rerun()}>
            <Icon name="rotate-cw" />
            Relancer avec mes remarques
          </button>
        )}
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
  const waitingHere =
    (operation.status === 'waiting_force' && step === 'force') ||
    (operation.status === 'waiting_repair' && step === 'repair') ||
    (operation.status === 'waiting_push' && step === 'push')
  const failure = step === 'analysis' ? (operation.analysis?.error ?? null) : step === 'repair' ? (operation.repair?.error ?? null) : operation.error
  const failedHere = (state === 'failed' || step === 'repair') && failure
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
      {step === 'analysis' && state === 'running' && operation.analysis && (
        <ClaudeActivity activity={operation.analysis.activity} hint="Le rapport et la tâche Organizer arrivent à la fin de l'analyse." />
      )}
      {step === 'repair' && state === 'running' && operation.repair && (
        <ClaudeActivity activity={operation.repair.activity} hint="Le commit et le rapport arrivent à la fin des corrections." />
      )}
      {step === 'analysis' && state === 'done' && operation.analysis?.report && <p className="step-body hint">{operation.analysis.report.summary}</p>}
      {step === 'repair' && state === 'done' && operation.status !== 'waiting_push' && operation.repair?.report && (
        <p className="step-body hint">{operation.repair.report.summary}</p>
      )}
      {operation.status === 'waiting_force' && step === 'force' && <ForceDecision operation={operation} onDone={onDone} />}
      {operation.status === 'waiting_repair' && step === 'repair' && <RepairLauncher operation={operation} onDone={onDone} />}
      {operation.status === 'waiting_push' && step === 'push' && <PushForm key={operation.id} operation={operation} onDone={onDone} />}
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
 * dépliée ; les sessions de Claude ; le journal. Les flèches passent aux autres
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
      : ['clone', 'audit', 'fix', ...(operation.analysis ? (['analysis'] as const) : []), 'force', ...(operation.analysis?.task ? (['repair'] as const) : []), 'push']

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
        {operation.sessions.length > 0 && (
          <button type="button" className={`tab${tab === 'claude' ? ' is-active' : ''}`} onClick={() => setTab('claude')}>
            Claude
            <span className="tab-count">{operation.sessions.length}</span>
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
              <StepRow key={step} operation={operation} step={step} onDone={polled.reload} />
            ))}
          </div>
          {operation.error && !Object.values(operation.steps).includes('failed') && <p className="banner banner-error pre">{operation.error}</p>}
        </>
      )}

      {tab === 'claude' && operation.sessions.length > 0 && <ClaudeSessions sessions={operation.sessions} active={isActive(operation)} />}

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
