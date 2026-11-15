import type { Deployment, DeploymentSummary, DeployServerView, RepoDeployResponse } from '@shared/schemas/deploy.schema'
import type { Repo } from '@shared/schemas/model.schema'
import { useEffect, useRef, useState } from 'react'
import { useDismiss } from '../../hooks/useDismiss'
import { usePolling } from '../../hooks/usePolling'
import { showError } from '../../store/useNotice'
import { api } from '../../utils/api'
import { clockTime, dayAndTime, relativeTime } from '../../utils/format'
import { hrefs, navigate } from '../../utils/router'
import { Icon, type IconName } from '../Icon'
import { lineCount } from '../../utils/script'
import { ServerStatus } from './DeployServers'
import { ScriptEditor, ScriptView, type LineMark } from './ScriptView'

const POLL_MS = 3000
const RUNNING_POLL_MS = 1000

/** Durée `m:ss` entre deux instants. */
function duration(from: string, to: string | null, now = Date.now()): string {
  const seconds = Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function shortCommit(commit: string | null): string {
  return commit ? commit.slice(0, 7) : '—'
}

/** Choix du serveur d'un dépôt : les serveurs des réglages, le détachement du dépôt et le lien vers leur gestion. */
function ServerMenu({ currentId, onChoose, className }: { currentId: string | null; onChoose: (id: string | null) => void; className: string }) {
  const servers = usePolling('deploy-servers', api.listDeployServers, null)
  const list = servers.data?.servers ?? []
  return (
    <div className={`picker-menu ${className}`}>
      {servers.error && <p className="picker-note error-text">{servers.error}</p>}
      {servers.data && list.length === 0 && <p className="picker-note">Aucun serveur enregistré.</p>}
      {list.length > 0 && (
        <ul className="picker-options" role="listbox" aria-label="Serveurs">
          {list.map(({ server }) => {
            const revoked = server.publicKey === null
            return (
              <li
                key={server.id}
                role="option"
                aria-selected={server.id === currentId}
                aria-disabled={revoked}
                className={`picker-option server-option${server.id === currentId ? ' is-active' : ''}${revoked ? ' is-disabled' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  if (!revoked && server.id !== currentId) onChoose(server.id)
                }}
              >
                <Icon name="server" size={14} />
                <span className="picker-name">
                  {server.name}
                  <span className="server-option-detail">
                    {server.username}@{server.host}:{server.port}
                  </span>
                </span>
                {revoked ? <span className="server-option-reason">clé révoquée</span> : server.id === currentId && <Icon name="check" size={14} className="picker-check" />}
              </li>
            )
          })}
        </ul>
      )}
      {currentId !== null && (
        <button type="button" className="menu-item menu-item-danger" onClick={() => onChoose(null)}>
          <Icon name="x" size={14} />
          Ne plus déployer ce dépôt
        </button>
      )}
      <a className="menu-item menu-item-link" href={hrefs.settings()}>
        <Icon name="settings" size={14} />
        Gérer les serveurs dans les Réglages
      </a>
    </div>
  )
}

function EmptyState({ repoId, onChanged }: { repoId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))

  async function choose(id: string | null) {
    setOpen(false)
    try {
      await api.setRepoDeployServer(repoId, id)
      onChanged()
    } catch (err) {
      showError(err)
    }
  }

  return (
    <>
      <div className="panel empty deploy-empty">
        <span className="deploy-empty-icon">
          <Icon name="rocket" size={24} />
        </span>
        <div className="deploy-empty-text">
          <p className="deploy-empty-title">Aucun serveur choisi</p>
          <p>Choisissez le serveur sur lequel ce dépôt se déploie, puis écrivez son script.</p>
        </div>
        <div className="picker" ref={ref}>
          <button type="button" className="button button-primary" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="server" />
            Choisir un serveur
          </button>
          {open && <ServerMenu currentId={null} onChoose={(id) => void choose(id)} className="picker-menu-center server-menu" />}
        </div>
      </div>
      <p className="hint">Les serveurs se créent et se connectent en SSH dans les Réglages.</p>
    </>
  )
}

interface ServerCardProps {
  repo: Repo
  view: DeployServerView
  deploy: RepoDeployResponse
  starting: boolean
  onDeploy: () => void
  onCancel: (deployment: Deployment) => void
  onChanged: () => void
}

/** Serveur du dépôt : son sélecteur, son état et « Déployer » (ou « Interrompre » pendant un déploiement). */
function ServerCard({ repo, view, deploy, starting, onDeploy, onCancel, onChanged }: ServerCardProps) {
  const { server } = view
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const active = deploy.activeDeployment
  const last = deploy.deployments.find((deployment) => deployment.status !== 'running') ?? null
  const hasKey = server.publicKey !== null
  const blocked = !hasKey
    ? 'Clé révoquée : installez une nouvelle clé dans les Réglages.'
    : server.testedAt === null
      ? 'Testez la connexion dans les Réglages avant de déployer.' : !deploy.script.trim() ? 'Écrivez le script avant de déployer.' : repo.deprecatedAt ? 'Dépôt déprécié.' : null

  async function choose(id: string | null) {
    setOpen(false)
    try {
      await api.setRepoDeployServer(repo.id, id)
      onChanged()
    } catch (err) {
      showError(err)
    }
  }

  const detail = !hasKey ? 'clé révoquée' : last ? `dernier déploiement ${relativeTime(last.createdAt)}` : server.testedAt ? `testé ${relativeTime(server.testedAt)}` : 'connexion à tester'

  return (
    <div className="panel deploy-server">
      <Icon name="server" size={20} className="deploy-server-icon" />
      <div className="deploy-server-text">
        <div className="picker" ref={ref}>
          <button
            type="button"
            className="server-chip"
            aria-haspopup="listbox"
            aria-expanded={open}
            title={active ? 'Un déploiement est en cours' : 'Changer de serveur'}
            disabled={active !== null}
            onClick={() => setOpen(!open)}
          >
            <span className="deploy-server-name">{server.name}</span>
            <Icon name="chevron-down" size={12} className="picker-chevron" />
          </button>
          {open && <ServerMenu currentId={server.id} onChoose={(id) => void choose(id)} className="server-menu" />}
        </div>
        <div className="deploy-server-detail">
          {active ? `${server.username}@${server.host}:${server.port} · ${active.branch} · ${shortCommit(active.commit)}` : `${server.username}@${server.host}:${server.port} · ${detail}`}
        </div>
      </div>
      {active ? (
        <span className="status-chip is-running">
          <span className="status-dot" />
          En cours
        </span>
      ) : hasKey && server.testedAt ? (
        <ServerStatus server={server} />
      ) : (
        <a className="status-chip-link" href={hrefs.settings()} title="Ouvrir les serveurs dans les Réglages">
          <ServerStatus server={server} />
        </a>
      )}
      {active ? (
        <button type="button" className="button button-secondary button-stop" onClick={() => onCancel(active)} disabled={active.cancelRequested}>
          <Icon name="square" size={14} />
          {active.cancelRequested ? 'Interruption…' : 'Interrompre'}
        </button>
      ) : (
        <button type="button" className="button button-queued" onClick={onDeploy} disabled={starting || blocked !== null} title={blocked ?? undefined}>
          <Icon name="rocket" />
          Déployer
        </button>
      )}
    </div>
  )
}

const STATUS: Record<Deployment['status'], { icon: IconName; className: string; text: string }> = {
  running: { icon: 'circle-dot', className: 'text-accent', text: 'en cours' },
  done: { icon: 'circle-check', className: 'text-ok', text: 'réussi' },
  failed: { icon: 'circle-x', className: 'error-text', text: 'échoué' },
  cancelled: { icon: 'circle-minus', className: 'muted', text: 'interrompu' },
}

function outcomeText(deployment: DeploymentSummary): string {
  if (deployment.status === 'failed' && deployment.exitCode !== null) {
    return `échoué${deployment.currentLine !== null ? ` à la ligne ${deployment.currentLine}` : ''} · code ${deployment.exitCode}`
  }
  return STATUS[deployment.status].text
}

/** Derniers déploiements du dépôt ; chaque ligne ouvre le déploiement. */
function DeploymentList({ repoId, deployments }: { repoId: string; deployments: DeploymentSummary[] }) {
  if (deployments.length === 0) return null
  return (
    <>
      <p className="section-label section-label-strong section-label-spaced">Derniers déploiements</p>
      <div className="panel list">
        {deployments.map((deployment) => {
          const status = STATUS[deployment.status]
          return (
            <a key={deployment.id} className="row row-linked deployment-row" href={hrefs.deployment(repoId, deployment.id)}>
              <Icon name={status.icon} className={`history-icon ${status.className}`} />
              <div className="history-title">
                <span className="row-title">Déploiement</span>
                <span className="history-meta">
                  {deployment.branch} · {shortCommit(deployment.commit)}
                </span>
              </div>
              <span className="history-date">{dayAndTime(deployment.createdAt)}</span>
              <span className="deployment-duration">{duration(deployment.createdAt, deployment.endedAt)}</span>
              <span className={`deployment-outcome ${deployment.status === 'failed' ? 'error-text' : ''}`}>{outcomeText(deployment)}</span>
              <Icon name="chevron-right" className="row-chevron" />
            </a>
          )
        })}
      </div>
      <p className="hint">Les 20 derniers déploiements du dépôt sont conservés.</p>
    </>
  )
}

function lineMark(deployment: Deployment): LineMark | null {
  if (deployment.currentLine === null) return null
  if (deployment.status === 'running') return { line: deployment.currentLine, state: 'running', label: 'en cours' }
  if (deployment.status === 'failed') return { line: deployment.currentLine, state: 'failed', label: deployment.exitCode !== null ? `code ${deployment.exitCode}` : 'échec' }
  if (deployment.status === 'cancelled') return { line: deployment.currentLine, state: 'failed', label: 'interrompu' }
  return null
}

/** Déploiement : le script avec sa ligne en cours ou en échec, et la sortie, qui suit la fin pendant l'exécution. */
function DeploymentDetail({ deployment, onBack }: { deployment: Deployment; onBack: (() => void) | null }) {
  const output = useRef<HTMLPreElement>(null)
  const running = deployment.status === 'running'
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  useEffect(() => {
    const box = output.current
    if (box && running) box.scrollTop = box.scrollHeight
  }, [deployment.output, running])

  const lines = lineCount(deployment.script)
  const status = STATUS[deployment.status]
  const title = running
    ? deployment.currentLine !== null
      ? `Exécution — ligne ${deployment.currentLine} sur ${lines}`
      : 'Exécution — connexion…'
    : deployment.status === 'done'
      ? 'Déploiement réussi'
      : deployment.status === 'cancelled'
        ? 'Déploiement interrompu'
        : 'Déploiement échoué'

  return (
    <>
      <div className="section-head">
        <p className="section-label section-label-strong deployment-title">
          {onBack && (
            <button type="button" className="icon-button" onClick={onBack} aria-label="Retour au déploiement" title="Retour au déploiement">
              <Icon name="arrow-left" />
            </button>
          )}
          <Icon name={running ? 'loader-circle' : status.icon} className={running ? 'spin text-accent' : status.className} />
          {title}
        </p>
        <span className="hint-inline">
          {running ? `lancé à ${clockTime(deployment.createdAt)}` : dayAndTime(deployment.createdAt)} · {duration(deployment.createdAt, deployment.endedAt)}
        </span>
      </div>
      <ScriptView script={deployment.script} mark={lineMark(deployment)} dimAfter={running} active={running} />
      {deployment.error && <p className="banner banner-error deployment-error">{deployment.error}</p>}
      <p className="section-label section-label-strong section-label-spaced">Sortie</p>
      <pre ref={output} className="terminal mono">
        {deployment.outputTruncated && <span className="muted">[début de la sortie coupé]{'\n'}</span>}
        {deployment.output}
        {running && <span className="terminal-cursor" />}
        {!running && !deployment.output && <span className="muted">Aucune sortie.</span>}
      </pre>
      <p className="hint-line">
        <Icon name="info" />
        {deployment.server} · {deployment.branch} · {shortCommit(deployment.commit)}
        {running ? ' · un déploiement réussi retire le dépôt de « À déployer ».' : ''}
      </p>
    </>
  )
}

/** Déploiement en cours, relu chaque seconde ; sa fin relit la vue du dépôt. */
function LiveDeployment({ id, onFinished }: { id: string; onFinished: () => void }) {
  const polled = usePolling(`deployment:${id}`, () => api.getDeployment(id), RUNNING_POLL_MS)
  const deployment = polled.data?.deployment
  const finished = deployment !== undefined && deployment.status !== 'running'

  useEffect(() => {
    if (finished) onFinished()
  }, [finished, onFinished])

  if (!deployment) return <p className={polled.error ? 'error-text' : 'muted'}>{polled.error ?? 'Chargement du déploiement…'}</p>
  return <DeploymentDetail deployment={deployment} onBack={null} />
}

/** Déploiement ouvert depuis la liste, relu tant qu'il s'exécute. */
function OpenedDeployment({ repoId, deploymentId }: { repoId: string; deploymentId: string }) {
  const polled = usePolling(`deployment:${deploymentId}`, () => api.getDeployment(deploymentId), RUNNING_POLL_MS)
  const deployment = polled.data?.deployment
  if (!deployment) return <p className={polled.error ? 'error-text' : 'muted'}>{polled.error ?? 'Chargement du déploiement…'}</p>
  return <DeploymentDetail deployment={deployment} onBack={() => navigate(hrefs.repoDeploy(repoId))} />
}

/**
 * Onglet « Déploiement » d'un dépôt : son serveur, son script et ses derniers
 * déploiements ; pendant un déploiement, son exécution en direct.
 */
export function DeployTab({ repo, deploymentId }: { repo: Repo; deploymentId: string | null }) {
  const polled = usePolling(`deploy:${repo.id}`, () => api.getRepoDeploy(repo.id), POLL_MS)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const deploy = polled.data
  const active = deploy?.activeDeployment ?? null

  if (!deploy) return <p className={polled.error ? 'error-text' : 'muted'}>{polled.error ?? 'Chargement du déploiement…'}</p>

  async function save(script: string) {
    setBusy(true)
    try {
      await api.saveRepoDeployScript(repo.id, script)
      setEditing(false)
      polled.reload()
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  async function start() {
    setBusy(true)
    try {
      await api.startDeployment(repo.id)
      if (deploymentId) navigate(hrefs.repoDeploy(repo.id))
      polled.reload()
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  async function cancel(deployment: Deployment) {
    try {
      await api.cancelDeployment(deployment.id)
      polled.reload()
    } catch (err) {
      showError(err)
    }
  }

  const shown = deploymentId === null && active ? active : null
  const content = !deploy.server ? (
    <EmptyState repoId={repo.id} onChanged={polled.reload} />
  ) : (
    <>
      <ServerCard
        repo={repo}
        view={deploy.server}
        deploy={deploy}
        starting={busy}
        onDeploy={() => void start()}
        onCancel={(deployment) => void cancel(deployment)}
        onChanged={polled.reload}
      />
      <div className="deploy-body">
        {deploymentId !== null ? (
          <OpenedDeployment repoId={repo.id} deploymentId={deploymentId} />
        ) : shown ? (
          <LiveDeployment id={shown.id} onFinished={polled.reload} />
        ) : editing ? (
          <ScriptEditor initial={deploy.script} busy={busy} onSave={(script) => void save(script)} onCancel={() => setEditing(false)} />
        ) : (
          <>
            <div className="section-head">
              <p className="section-label section-label-strong">Script de déploiement</p>
              <button type="button" className="button button-secondary button-small" onClick={() => setEditing(true)}>
                <Icon name="pencil" size={14} />
                {deploy.script.trim() ? 'Modifier' : 'Écrire le script'}
              </button>
            </div>
            {deploy.script.trim() ? (
              <ScriptView script={deploy.script} />
            ) : (
              <div className="panel empty">
                <p>Aucun script : il s'écrit en bash et s'exécute sur le serveur à chaque déploiement.</p>
              </div>
            )}
            <DeploymentList repoId={repo.id} deployments={deploy.deployments} />
          </>
        )}
      </div>
    </>
  )

  return content
}
