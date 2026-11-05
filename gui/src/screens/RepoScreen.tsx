import { handledAlerts, pendingAlerts } from '@shared/alerts'
import type { RepoView } from '@shared/schemas/api.schema'
import { RIGHTS, type AuditScope, type Right, type Rights } from '@shared/schemas/model.schema'
import { useEffect, useState } from 'react'
import { BranchSelector } from '../components/BranchSelector'
import { CategorySelector } from '../components/CategorySelector'
import { Icon } from '../components/Icon'
import { OperationHistory } from '../components/OperationHistory'
import { ScopeButton } from '../components/ScopeButton'
import { SeverityPill } from '../components/Pill'
import { Toggle } from '../components/Toggle'
import { usePolling } from '../hooks/usePolling'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { dayAndTime, relativeTime, SEVERITY_LABELS } from '../utils/format'
import { hrefs, navigate, type RepoTab } from '../utils/router'

const POLL_MS = 3000

/** Délai pendant lequel un second clic confirme le retrait du dépôt. */
const CONFIRM_MS = 4000

const RIGHT_TEXTS: Record<Right, { label: string; description: string }> = {
  audit: { label: 'Audit', description: 'Cloner le dépôt et lancer npm audit' },
  fix: { label: 'Audit fix', description: 'Appliquer npm audit fix dans le clone' },
  force: { label: 'Audit fix --force', description: 'Peut installer des versions majeures' },
  push: { label: 'Commit et push', description: 'Pousser sur une nouvelle branche et ouvrir la PR' },
}

/** Volet des droits de l'agent : chaque interrupteur s'enregistre aussitôt. */
function AgentDrawer({ view, onClose, onChanged }: { view: RepoView; onClose: () => void; onChanged: () => void }) {
  const { repo } = view
  // Droits en cours d'enregistrement, affichés avant que la relecture du dépôt ne les confirme.
  const [pending, setPending] = useState<Rights | null>(null)
  if (pending && RIGHTS.every((right) => pending[right] === repo.rights[right])) setPending(null)
  const rights = pending ?? repo.rights
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  async function change(right: Right, value: boolean) {
    const next = { ...rights, [right]: value }
    setPending(next)
    try {
      await api.setRights(repo.id, next)
      onChanged()
    } catch (err) {
      setPending(null)
      showError(err)
    }
  }

  async function remove() {
    if (!confirming) {
      setConfirming(true)
      return
    }
    try {
      await api.removeRepo(repo.id)
      navigate(hrefs.lastHome())
    } catch (err) {
      setConfirming(false)
      showError(err)
    }
  }

  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer" aria-label="Droits de l'agent">
        <div className="drawer-head">
          <h2 className="drawer-title">Droits de l'agent</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer">
            <Icon name="x" size={18} />
          </button>
        </div>
        <p className="drawer-subtitle">Ce que l'agent peut faire sur ce dépôt.</p>
        <div className="rights">
          {RIGHTS.map((right) => (
            <div key={right} className="right">
              <div>
                <div className="right-label">{RIGHT_TEXTS[right].label}</div>
                <div className="right-description">{RIGHT_TEXTS[right].description}</div>
              </div>
              <Toggle checked={rights[right]} onChange={(value) => void change(right, value)} label={RIGHT_TEXTS[right].label} />
            </div>
          ))}
        </div>
        <button type="button" className="danger-link" onClick={() => void remove()}>
          <Icon name="trash-2" />
          {confirming ? 'Cliquer à nouveau pour retirer le dépôt' : 'Retirer le dépôt'}
        </button>
      </aside>
    </div>
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
 * Écran d'un dépôt : ses alertes Dependabot ouvertes et son historique en deux
 * onglets, la correction et les droits de l'agent ; un dépôt déprécié ne se
 * corrige pas.
 */
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

export function RepoScreen({ repoId, tab }: { repoId: string; tab: RepoTab }) {
  const polled = usePolling(`repo:${repoId}`, () => api.getRepo(repoId), POLL_MS)
  const history = usePolling(`history:${repoId}`, () => api.listOperations(repoId), POLL_MS)
  const [drawer, setDrawer] = useState(false)
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
          <h1 className="page-title">{repo.name}</h1>
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
          {!repo.deprecatedAt && <QueueButton view={view} onChanged={polled.reload} />}
          <button type="button" className="button button-secondary" onClick={() => setDrawer(true)}>
            <Icon name="bot" />
            Agent
          </button>
          {activeOperation ? (
            <button type="button" className="button button-primary" onClick={() => navigate(hrefs.operation(repo.id, activeOperation.id))}>
              <Icon name="wrench" />
              {activeOperation.kind === 'audit' ? "Voir l'audit en cours" : 'Reprendre la correction'}
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
      </nav>

      {tab === 'alerts' ? (
        <>
          <PendingAlerts view={view} onChanged={polled.reload} />
          <HandledAlerts view={view} onChanged={polled.reload} />
        </>
      ) : history.data ? (
        <OperationHistory repoId={repo.id} operations={operations} />
      ) : (
        <p className={history.error ? 'error-text' : 'muted'}>{history.error ?? "Chargement de l'historique…"}</p>
      )}

      {drawer && <AgentDrawer view={view} onClose={() => setDrawer(false)} onChanged={polled.reload} />}
    </div>
  )
}
