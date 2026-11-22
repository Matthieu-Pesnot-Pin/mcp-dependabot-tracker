import type { Operation, StepState } from '@shared/schemas/model.schema'
import { AnsiUp } from 'ansi_up'
import { useMemo, useState, type ReactNode } from 'react'
import { usePolling } from '../hooks/usePolling'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { plural } from '../utils/format'
import { hrefs } from '../utils/router'
import { lineCount } from '../utils/script'
import { Icon, type IconName } from './Icon'

const STEP_ICONS: Record<StepState, IconName> = {
  pending: 'circle',
  running: 'loader-circle',
  done: 'circle-check',
  skipped: 'circle-minus',
  failed: 'circle-x',
}

/** Relecture du déploiement pendant qu'il s'exécute. */
const DEPLOYMENT_POLL_MS = 1000

/** Dernières lignes de la sortie montrées pendant le déploiement. */
const OUTPUT_TAIL_LINES = 8

/** Durée `m:ss` depuis `from`, jusqu'à `to` ou maintenant. */
function duration(from: string, to: string | null): string {
  const seconds = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Ligne d'une étape de la suite automatique : icône d'état, libellé, résultat à droite, puis son détail. */
function DeliveryStep({ state, label, result, children }: { state: StepState; label: string; result: ReactNode; children?: ReactNode }) {
  const current = state === 'running' || state === 'failed'
  return (
    <div className={`step step-${state}${current ? ' step-current' : ''}`}>
      <div className="step-line">
        <Icon name={STEP_ICONS[state]} className={`step-icon${state === 'running' ? ' spin' : ''}${state === 'failed' ? ' error-text' : ''}`} />
        <span className="step-label">{label}</span>
        <span className="step-result">{result}</span>
      </div>
      {children}
    </div>
  )
}

/** Bouton qui reprend la suite automatique de l'opération là où elle s'est arrêtée. */
function RetryButton({ operation, label, onResumed }: { operation: Operation; label: string; onResumed: () => void }) {
  const [busy, setBusy] = useState(false)

  async function retry() {
    setBusy(true)
    try {
      await api.retryDelivery(operation.id)
      onResumed()
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button type="button" className="button button-primary button-small" onClick={() => void retry()} disabled={busy}>
      <Icon name="rotate-cw" size={14} />
      {label}
    </button>
  )
}

/** Merge de la pull request : attente des checks, merge, ou raison de l'arrêt avec la relance. */
function MergeStep({ operation, onResumed }: { operation: Operation; onResumed: () => void }) {
  const delivery = operation.delivery!
  const pull = operation.pullRequest
  const result =
    delivery.merge === 'running'
      ? 'attente des checks'
      : delivery.merge === 'done'
        ? `${delivery.checks ? plural(delivery.checks, 'check vert', 'checks verts') : 'aucun check'} · mergée dans ${operation.baseBranch}`
        : delivery.merge === 'failed'
          ? <span className="error-text">arrêté</span>
          : delivery.merge === 'skipped'
            ? pull ? 'ignoré' : 'aucune pull request'
            : null

  return (
    <DeliveryStep state={delivery.merge} label="Merge de la pull request" result={result}>
      {delivery.merge === 'failed' && (
        <div className="step-body delivery-body">
          <p className="error-text pre">{delivery.error}</p>
          <p className="muted">La pull request reste ouverte et attend dans « <a className="link" href={hrefs.pulls()}>PR en attente</a> ».</p>
          {operation.status !== 'running' && (
            <div className="delivery-actions">
              <RetryButton operation={operation} label="Relancer le merge" onResumed={onResumed} />
              {pull && (
                <a className="button button-secondary button-small" href={pull.url} target="_blank" rel="noreferrer">
                  <Icon name="external-link" size={14} />
                  Ouvrir la PR
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </DeliveryStep>
  )
}

/** Déploiement en cours : la fin de sa sortie, le lien vers son écran et « Interrompre ». */
function DeploymentProgress({ repoId, id }: { repoId: string; id: string }) {
  const polled = usePolling(`deployment:${id}`, () => api.getDeployment(id), DEPLOYMENT_POLL_MS)
  const deployment = polled.data?.deployment
  const tail = useMemo(() => {
    const text = (deployment?.output ?? '').split('\n').slice(-OUTPUT_TAIL_LINES).join('\n')
    const ansi = new AnsiUp()
    ansi.use_classes = true
    return ansi.ansi_to_html(text)
  }, [deployment?.output])

  async function interrupt() {
    try {
      await api.cancelDeployment(id)
      polled.reload()
    } catch (err) {
      showError(err)
    }
  }

  return (
    <div className="step-body delivery-body">
      <pre className="terminal mono delivery-output">
        <span dangerouslySetInnerHTML={{ __html: tail }} />
        {!deployment?.output && <span className="muted">Connexion au serveur…</span>}
      </pre>
      <div className="delivery-actions">
        <a className="link" href={hrefs.deployment(repoId, id)}>
          Ouvrir le déploiement
        </a>
        <span className="delivery-spacer" />
        <button type="button" className="button button-secondary button-small" onClick={() => void interrupt()} disabled={deployment?.cancelRequested ?? true}>
          <Icon name="square" size={12} />
          {deployment?.cancelRequested ? 'Interruption…' : 'Interrompre'}
        </button>
      </div>
    </div>
  )
}

/** Avancement d'un déploiement en cours, à droite de sa ligne : ligne du script et durée. */
function DeploymentClock({ id }: { id: string }) {
  const polled = usePolling(`deployment:${id}`, () => api.getDeployment(id), DEPLOYMENT_POLL_MS)
  const deployment = polled.data?.deployment
  if (!deployment) return null
  const line = deployment.currentLine !== null ? `ligne ${deployment.currentLine} sur ${lineCount(deployment.script)} · ` : ''
  return <>{`${line}${duration(deployment.createdAt, deployment.endedAt)}`}</>
}

/** Déploiement sur le serveur du dépôt : en direct, réussi, ou raison de l'échec avec la relance. */
function DeployStep({ operation, onResumed }: { operation: Operation; onResumed: () => void }) {
  const delivery = operation.delivery!
  const id = delivery.deploymentId
  const open = id && (
    <a className="link" href={hrefs.deployment(operation.repoId, id)}>
      Ouvrir le déploiement
    </a>
  )
  const result =
    delivery.deploy === 'running'
      ? id && <DeploymentClock id={id} />
      : delivery.deploy === 'done'
        ? <>réussi{open && <>{' · '}{open}</>}</>
        : delivery.deploy === 'failed'
          ? <span className="error-text">en échec</span>
          : delivery.deploy === 'skipped'
            ? 'non lancé'
            : null

  return (
    <DeliveryStep state={delivery.deploy} label="Déploiement" result={result}>
      {delivery.deploy === 'running' && id && <DeploymentProgress repoId={operation.repoId} id={id} />}
      {delivery.deploy === 'failed' && (
        <div className="step-body delivery-body">
          <p className="error-text pre">{delivery.error}</p>
          <p className="muted">Le dépôt est marqué « <a className="link" href={hrefs.deploy()}>À déployer</a> ».</p>
          {operation.status !== 'running' && (
            <div className="delivery-actions">
              <RetryButton operation={operation} label="Relancer le déploiement" onResumed={onResumed} />
              {open}
            </div>
          )}
        </div>
      )}
    </DeliveryStep>
  )
}

/**
 * Suite d'une correction en workflow automatique, sous ses étapes : merge de
 * la pull request une fois ses checks verts, puis déploiement.
 */
export function DeliverySteps({ operation, onResumed }: { operation: Operation; onResumed: () => void }) {
  return (
    <>
      <div className="delivery-divider">
        <Icon name="zap" size={12} />
        Suite du workflow automatique
      </div>
      <MergeStep operation={operation} onResumed={onResumed} />
      <DeployStep operation={operation} onResumed={onResumed} />
    </>
  )
}
