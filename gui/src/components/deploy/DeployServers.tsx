import type { DeployServerListItem, DeployServerView } from '@shared/schemas/deploy.schema'
import { useState } from 'react'
import { useDismiss } from '../../hooks/useDismiss'
import { usePolling } from '../../hooks/usePolling'
import { showError } from '../../store/useNotice'
import { api } from '../../utils/api'
import { Icon } from '../Icon'
import { RevokeKeyModal, RotateKeyModal } from './KeyModals'
import { ServerWizard, type WizardStep } from './ServerWizard'

const POLL_MS = 5000

/** « 3 dépôts », « 1 dépôt », « aucun dépôt ». */
function repoCountText(count: number): string {
  return count === 0 ? 'aucun dépôt' : `${count} dépôt${count > 1 ? 's' : ''}`
}

/** État de la connexion d'un serveur, en pastille. */
export function ServerStatus({ server }: { server: DeployServerView['server'] }) {
  if (server.publicKey === null) {
    return (
      <span className="status-chip is-danger">
        <span className="status-dot" />
        Clé révoquée
      </span>
    )
  }
  if (server.testedAt === null) {
    return (
      <span className="status-chip is-idle">
        <span className="status-dot" />
        À tester
      </span>
    )
  }
  return (
    <span className="status-chip is-ok">
      <span className="status-dot" />
      Connecté
    </span>
  )
}

interface ServerRowProps {
  item: DeployServerListItem
  onWizard: (step: WizardStep, view?: DeployServerView) => void
  onKey: (action: 'rotate' | 'revoke') => void
  onChanged: () => void
}

/** Ligne d'un serveur : connexion, dépôts qui le choisissent, état et menu de ses actions. */
function ServerRow({ item, onWizard, onKey, onChanged }: ServerRowProps) {
  const { server } = item
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const hasKey = server.publicKey !== null
  const deleteBlocked = item.repoCount > 0 ? `utilisé par ${repoCountText(item.repoCount)}` : hasKey ? 'révoquez sa clé' : null

  async function installKey() {
    setOpen(false)
    try {
      const fresh = await api.installDeployKey(server.id)
      onChanged()
      onWizard('key', fresh)
    } catch (err) {
      showError(err)
    }
  }

  async function remove() {
    setOpen(false)
    try {
      await api.deleteDeployServer(server.id)
      onChanged()
    } catch (err) {
      showError(err)
    }
  }

  return (
    <div className="server-row">
      <Icon name="server" size={20} className="server-row-icon" />
      <div className="server-row-text">
        <div className="server-row-name">{server.name}</div>
        <div className="server-row-detail">
          {server.username}@{server.host}:{server.port}
        </div>
      </div>
      <span className={`server-row-count${item.repoCount === 0 ? ' is-none' : ''}`}>{repoCountText(item.repoCount)}</span>
      <ServerStatus server={server} />
      <div className="picker" ref={ref}>
        <button
          type="button"
          className={`icon-button server-row-more${open ? ' is-open' : ''}`}
          aria-label={`Menu du serveur ${server.name}`}
          title="Menu du serveur"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name="ellipsis" size={16} />
        </button>
        {open && (
          <div className="picker-menu picker-menu-right server-row-menu">
            <button type="button" className="menu-item" onClick={() => (setOpen(false), onWizard('form'))}>
              <Icon name="pencil" size={14} />
              Modifier
            </button>
            {hasKey ? (
              <button type="button" className="menu-item" onClick={() => (setOpen(false), onWizard('key'))}>
                <Icon name="plug" size={14} />
                Tester la connexion
              </button>
            ) : (
              <button type="button" className="menu-item" onClick={() => void installKey()}>
                <Icon name="key-round" size={14} />
                Installer une clé
              </button>
            )}
            {hasKey && (
              <>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => (setOpen(false), onKey('rotate'))}
                  disabled={server.hostKeyFingerprint === null}
                  title={server.hostKeyFingerprint === null ? 'Testez la connexion avant de changer de clé.' : undefined}
                >
                  <Icon name="refresh-cw" size={14} />
                  Changer de clé
                </button>
                <button type="button" className="menu-item menu-item-danger" onClick={() => (setOpen(false), onKey('revoke'))}>
                  <Icon name="key-round" size={14} />
                  Révoquer la clé
                </button>
              </>
            )}
            <span className="menu-divider" />
            <button type="button" className="menu-item menu-item-danger" onClick={() => void remove()} disabled={deleteBlocked !== null}>
              <Icon name="trash-2" size={14} />
              Supprimer
              {deleteBlocked && <span className="menu-item-reason">{deleteBlocked}</span>}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Section « Serveurs de déploiement » des réglages : les serveurs connectés en
 * SSH, partagés par les dépôts, qui en choisissent un dans leur onglet Déploiement.
 */
export function DeployServers() {
  const polled = usePolling('deploy-servers', api.listDeployServers, POLL_MS)
  const [wizard, setWizard] = useState<{ server: DeployServerView | null; step: WizardStep } | null>(null)
  const [keyAction, setKeyAction] = useState<{ action: 'rotate' | 'revoke'; view: DeployServerView } | null>(null)
  const servers = polled.data?.servers ?? []

  return (
    <>
      <div className="section-head">
        <p className="section-label">Serveurs de déploiement</p>
        <button type="button" className="button button-secondary button-small" onClick={() => setWizard({ server: null, step: 'form' })}>
          <Icon name="plus" />
          Ajouter un serveur
        </button>
      </div>
      {servers.length > 0 && (
        <div className="panel settings-card server-list">
          {servers.map((item) => (
            <ServerRow
              key={item.server.id}
              item={item}
              onWizard={(step, view) => setWizard({ server: view ?? item, step })}
              onKey={(action) => setKeyAction({ action, view: item })}
              onChanged={polled.reload}
            />
          ))}
        </div>
      )}
      {polled.error && <p className="error-text">{polled.error}</p>}
      <p className="hint settings-hint">Chaque dépôt choisit ensuite son serveur dans son onglet Déploiement.</p>

      {wizard && <ServerWizard server={wizard.server} step={wizard.step} onClose={() => setWizard(null)} onChanged={polled.reload} />}
      {keyAction?.action === 'rotate' && <RotateKeyModal view={keyAction.view} onClose={() => setKeyAction(null)} onChanged={polled.reload} />}
      {keyAction?.action === 'revoke' && <RevokeKeyModal view={keyAction.view} onClose={() => setKeyAction(null)} onChanged={polled.reload} />}
    </>
  )
}
