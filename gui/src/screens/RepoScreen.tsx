import { handledAlerts, pendingAlerts } from '@shared/alerts'
import type { RepoView } from '@shared/schemas/api.schema'
import type { AuditScope } from '@shared/schemas/model.schema'
import { useEffect, useState } from 'react'
import { BranchSelector } from '../components/BranchSelector'
import { CategorySelector } from '../components/CategorySelector'
import { DeployTab } from '../components/deploy/DeployTab'
import { Icon } from '../components/Icon'
import { OperationHistory } from '../components/OperationHistory'
import { ScopeButton } from '../components/ScopeButton'
import { SeverityPill } from '../components/Pill'
import { usePolling } from '../hooks/usePolling'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { dayAndTime, relativeTime, SEVERITY_LABELS } from '../utils/format'
import { hrefs, navigate, type RepoTab } from '../utils/router'

const POLL_MS = 3000

/** Délai pendant lequel un second clic confirme le retrait du dépôt. */
const CONFIRM_MS = 4000

/** Retire le dépôt du suivi ; un second clic dans les 4 secondes confirme. Refusé pendant une opération. */
function RemoveButton({ repoId }: { repoId: string }) {
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  async function remove() {
    if (!confirming) {
      setConfirming(true)
      return
    }
    try {
      await api.removeRepo(repoId)
      navigate(hrefs.lastHome())
    } catch (err) {
      setConfirming(false)
      showError(err)
    }
  }

  return confirming ? (
    <button type="button" className="button button-secondary button-danger" onClick={() => void remove()}>
      <Icon name="trash-2" />
      Confirmer le retrait
    </button>
  ) : (
    <button type="button" className="button button-secondary button-icon" onClick={() => void remove()} aria-label="Retirer le dépôt" title="Retirer le dépôt">
      <Icon name="trash-2" />
    </button>
  )
}

/**
 * Alertes encore à traiter. Chaque ligne ouvre l'alerte sur GitHub ; au survol,
 * « Corrigée à la main » la range dans les alertes corrigées à la main. Un
 * paquet que le dernier audit n'a pas pu corriger est signalé, une dépendance
 * de développement porte l'étiquette « dév. ».
 */
function PendingAlerts({ view, onChanged }: { view: RepoView; onChanged: () => void }) {
  const { repo, unfixable } = view
  const alerts = pendingAlerts(repo)

  async function mark(number: number) {
    try {
      await api.markAlertHandled(repo.id, number)
      onChanged()
    } catch (err) {
      showError(err)
    }
  }

  if (alerts.length === 0) {
    return (
      <div className="panel empty">
        <p>{repo.alerts.length === 0 ? 'Aucune alerte ouverte.' : 'Toutes les alertes sont corrigées à la main.'}</p>
      </div>
    )
  }
  return (
    <>
      <div className="panel list">
        {alerts.map((alert) => (
          <div key={alert.number} className="alert-line">
            <a className="row alert-row" href={alert.url} target="_blank" rel="noreferrer" title={`Alerte #${alert.number} sur GitHub`}>
              <SeverityPill severity={alert.severity} wide>
                {SEVERITY_LABELS[alert.severity]}
              </SeverityPill>
              <span className="alert-package mono">{alert.package}</span>
              <span className="alert-summary">{alert.summary}</span>
              {unfixable.includes(alert.package) && (
                <span className="unfixable-note" title="Le dernier audit n'a trouvé aucune version corrigée publiée sur le registre npm.">
                  <Icon name="triangle-alert" />
                  sans correctif
                </span>
              )}
              {alert.scope === 'development' && (
                <span className="dev-tag" title="Dépendance de développement : un audit de production la laisse de côté.">
                  dév.
                </span>
              )}
              <span className="alert-mark-space" />
              <Icon name="external-link" className="row-chevron" />
            </a>
            <button type="button" className="button button-secondary alert-mark" onClick={() => void mark(alert.number)}>
              <Icon name="check" size={14} />
              Corrigée à la main
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

/** Alertes marquées corrigées à la main, avec la date du marquage ; « Rétablir » les remet à traiter. */
function HandledAlerts({ view, onChanged }: { view: RepoView; onChanged: () => void }) {
  const { repo } = view
  const alerts = handledAlerts(repo)
  if (alerts.length === 0) return null

  async function restore(number: number) {
    try {
      await api.unmarkAlertHandled(repo.id, number)
      onChanged()
    } catch (err) {
      showError(err)
    }
  }

  return (
    <>
      <p className="section-label section-label-spaced">Corrigées à la main</p>
      <div className="panel list">
        {alerts.map((alert) => {
          const mark = repo.handledAlerts.find((candidate) => candidate.number === alert.number)
          return (
            <div key={alert.number} className="row alert-row">
              <SeverityPill severity={alert.severity} wide faded>
                {SEVERITY_LABELS[alert.severity]}
              </SeverityPill>
              <span className="alert-package mono">{alert.package}</span>
              <span className="alert-summary handled-note">
                <Icon name="circle-check" className="text-ok" />
                Corrigée à la main{mark && ` le ${dayAndTime(mark.markedAt)}`}
              </span>
              <button type="button" className="link restore-link" onClick={() => void restore(alert.number)}>
                Rétablir
              </button>
            </div>
          )
        })}
      </div>
    </>
  )
}

/**
 * Bouton de file d'attente de l'en-tête : « Traité » retire de la file un dépôt
 * qui y est et ramène à la file ; « Ajouter à la file » y met un dépôt qui n'y
 * est pas.
 */
function QueueButton({ view, onChanged }: { view: RepoView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const repoId = view.repo.id
  const queued = view.repo.queuedAt !== null

  async function toggle() {
    setBusy(true)
    try {
      if (queued) {
        await api.unqueueRepo(repoId)
        navigate(hrefs.queue())
        return
      }
      await api.queueRepo(repoId)
      onChanged()
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  return queued ? (
    <button type="button" className="button button-queued" onClick={() => void toggle()} disabled={busy} title="Retirer de la file d'attente">
      <Icon name="list-check" />
      Traité
    </button>
  ) : (
    <button type="button" className="button button-secondary" onClick={() => void toggle()} disabled={busy}>
      <Icon name="list-plus" />
      Ajouter à la file
    </button>
  )
}

/**
 * Bouton « à déployer » de l'en-tête : « Déployé », allumé, retire la marque
 * d'un dépôt qui l'a ; « À déployer » marque un dépôt qui ne l'a pas.
 */
function DeployButton({ view, onChanged }: { view: RepoView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const repoId = view.repo.id
  const pending = view.repo.deployPendingAt !== null

  async function toggle() {
    setBusy(true)
    try {
      await (pending ? api.unmarkDeployPending(repoId) : api.markDeployPending(repoId))
      onChanged()
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  return pending ? (
    <button type="button" className="button button-queued" onClick={() => void toggle()} disabled={busy} title="Retirer de « À déployer »">
      <Icon name="rocket" />
      Déployé
    </button>
  ) : (
    <button type="button" className="button button-secondary" onClick={() => void toggle()} disabled={busy}>
      <Icon name="rocket" />
      À déployer
    </button>
  )
}

/**
 * Écran d'un dépôt : ses alertes Dependabot ouvertes, son historique et son
 * déploiement en trois onglets, et la correction ; un dépôt déprécié ne se
 * corrige pas.
 */
export function RepoScreen({ repoId, tab, deploymentId }: { repoId: string; tab: RepoTab; deploymentId: string | null }) {
  const polled = usePolling(`repo:${repoId}`, () => api.getRepo(repoId), POLL_MS)
  const history = usePolling(`history:${repoId}`, () => api.listOperations(repoId), POLL_MS)
  const config = usePolling('config', api.getConfig, null)
  const [starting, setStarting] = useState(false)
  const view = polled.data

  if (!view) {
    return (
      <div className="page">
        <p className={polled.error ? 'error-text' : 'muted'}>{polled.error ?? 'Chargement du dépôt…'}</p>
      </div>
    )
  }
  const { repo, activeOperation } = view
  const pending = pendingAlerts(repo).length
  const operations = history.data?.operations ?? []

  async function fix(scope: AuditScope) {
    setStarting(true)
    try {
      const { operation } = await api.startFix(repo.id, scope)
      navigate(hrefs.operation(repo.id, operation.id))
    } catch (err) {
      showError(err)
      setStarting(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <a className="back" href={hrefs.lastHome()} aria-label="Retour aux dépôts">
          <Icon name="arrow-left" size={20} />
        </a>
        <div className="page-head-text">
          <h1 className="page-title">
            {repo.name}
            {config.data && (
              <a
                className="title-link"
                href={`${config.data.githubServerUrl}/${repo.id}`}
                target="_blank"
                rel="noreferrer"
                title={`Ouvrir ${repo.id} sur GitHub`}
                aria-label={`Ouvrir ${repo.id} sur GitHub`}
              >
                <Icon name="external-link" size={16} />
              </a>
            )}
          </h1>
          <div className="subtitle">
            {repo.owner} · <BranchSelector repo={repo} onChanged={polled.reload} /> ·{' '}
            <CategorySelector repo={repo} categoryName={view.category?.name ?? null} onChanged={polled.reload} /> ·{' '}
            {repo.deprecatedAt ? (
              `déprécié le ${dayAndTime(repo.deprecatedAt)}`
            ) : repo.syncError ? (
              <span className="error-text" title={repo.syncError}>
                synchronisation impossible
              </span>
            ) : repo.syncedAt ? (
              `synchronisé ${relativeTime(repo.syncedAt)}`
            ) : (
              'synchronisation…'
            )}
          </div>
        </div>
        <div className="page-actions">
          {!repo.deprecatedAt && <DeployButton view={view} onChanged={polled.reload} />}
          {!repo.deprecatedAt && <QueueButton view={view} onChanged={polled.reload} />}
          <RemoveButton repoId={repo.id} />
          {activeOperation ? (
            <button type="button" className="button button-primary" onClick={() => navigate(hrefs.operation(repo.id, activeOperation.id))}>
              <Icon name="wrench" />
              {activeOperation.kind === 'audit' ? "Voir l'audit en cours" : 'Voir la correction en cours'}
            </button>
          ) : repo.deprecatedAt ? (
            <button
              type="button"
              className="button button-primary"
              disabled
              title="Dépôt déprécié : rétablissez-le depuis l’onglet « Dépréciés » pour le corriger."
            >
              <Icon name="wrench" />
              Corriger
            </button>
          ) : (
            <ScopeButton variant="primary" icon="wrench" label="Corriger" disabled={starting} onLaunch={(scope) => void fix(scope)} />
          )}
        </div>
      </div>

      {repo.syncError && <p className="banner banner-error">{repo.syncError}</p>}

      <nav className="tabs">
        <a className={`tab${tab === 'alerts' ? ' is-active' : ''}`} href={hrefs.repo(repo.id)}>
          Alertes ouvertes
          {pending > 0 && <span className="tab-count tab-count-alert">{pending}</span>}
        </a>
        <a className={`tab${tab === 'history' ? ' is-active' : ''}`} href={hrefs.repoHistory(repo.id)}>
          Historique
          {operations.length > 0 && <span className="tab-count">{operations.length}</span>}
        </a>
        <a className={`tab${tab === 'deploy' ? ' is-active' : ''}`} href={hrefs.repoDeploy(repo.id)}>
          Déploiement
        </a>
      </nav>

      {tab === 'alerts' ? (
        <>
          <PendingAlerts view={view} onChanged={polled.reload} />
          <HandledAlerts view={view} onChanged={polled.reload} />
        </>
      ) : tab === 'deploy' ? (
        <DeployTab repo={repo} deploymentId={deploymentId} />
      ) : history.data ? (
        <OperationHistory repoId={repo.id} operations={operations} />
      ) : (
        <p className={history.error ? 'error-text' : 'muted'}>{history.error ?? "Chargement de l'historique…"}</p>
      )}

    </div>
  )
}
