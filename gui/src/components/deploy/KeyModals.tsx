import type { DeployServerView, RotationResponse } from '@shared/schemas/deploy.schema'
import { useEffect, useState, type ReactNode } from 'react'
import { showError, useNotice } from '../../store/useNotice'
import { api } from '../../utils/api'
import { Icon } from '../Icon'

const DEDICATED_KEY_FILE = '.ssh/authorized_keys.d/dependabot-tracker'

type StepState = 'todo' | 'done' | 'failed' | 'skipped'

interface StepItem {
  title: string
  detail: string
  state: StepState
}

/** Étapes numérotées d'une opération sur la clé, avec leur état. */
function KeySteps({ steps }: { steps: StepItem[] }) {
  return (
    <div className="key-steps">
      {steps.map((item, index) => (
        <div key={item.title} className={`key-step is-${item.state}`}>
          <span className="key-step-dot">{item.state === 'done' ? <Icon name="check" size={12} /> : item.state === 'failed' ? <Icon name="x" size={12} /> : index + 1}</span>
          <div>
            <div className="key-step-title">{item.title}</div>
            <div className="key-step-detail">{item.detail}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Clé publique abrégée, avec sa date de génération. */
function CurrentKey({ view, label }: { view: DeployServerView; label: string }) {
  const parts = (view.server.publicKey ?? '').split(/\s+/)
  const body = parts[1] ?? ''
  const short = body.length > 20 ? `${body.slice(0, 8)}…${body.slice(-6)}` : body
  const created = view.server.keyCreatedAt
    ? ` · créée le ${new Date(view.server.keyCreatedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}`
    : ''
  return (
    <div className="current-key">
      <Icon name="key-round" size={20} />
      <div>
        <div className="current-key-label">
          {label}
          {created}
        </div>
        <div className="mono">{[parts[0], short, parts[2]].filter(Boolean).join(' ')}</div>
      </div>
    </div>
  )
}

function KeyModal({ title, busy, onClose, footer, children }: { title: string; busy: boolean; onClose: () => void; footer: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="modal modal-wizard" role="dialog" aria-label={title}>
        <div className="wizard-head">
          <h2 className="wizard-title">{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} title="Fermer" aria-label="Fermer">
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="wizard-body">{children}</div>
        <div className="wizard-foot">{footer}</div>
      </div>
    </div>
  )
}

interface KeyModalProps {
  view: DeployServerView
  onClose: () => void
  /** Clé changée ou effacée : la vue du déploiement se relit. */
  onChanged: () => void
}

const ROTATION_STEPS: { title: string; detail: string }[] = [
  { title: 'Générer une nouvelle paire de clés', detail: "ed25519, la clé privée chiffrée comme l'actuelle" },
  { title: 'Ajouter la nouvelle clé publique sur le serveur', detail: `dans ~/${DEDICATED_KEY_FILE}, à côté de la clé actuelle` },
  { title: 'Ouvrir une connexion avec la nouvelle clé', detail: "une seconde connexion, pour vérifier qu'elle est acceptée" },
  { title: "Retirer l'ancienne clé", detail: 'le fichier ne garde que la nouvelle, seulement si la connexion a réussi' },
]

/** Renouvellement de la clé, comme dans SSH Gate : confirmation, puis déroulé des quatre étapes. */
export function RotateKeyModal({ view, onClose, onChanged }: KeyModalProps) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<RotationResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function rotate() {
    setBusy(true)
    setError(null)
    try {
      setOutcome(await api.rotateDeployKey(view.server.id))
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const failedAt = outcome ? outcome.steps.indexOf('failed') : -1
  const steps: StepItem[] = ROTATION_STEPS.map((item, index) => {
    const status = outcome?.steps[index]
    const state: StepState = status === 'done' ? 'done' : status === 'failed' ? 'failed' : failedAt !== -1 && index > failedAt ? 'skipped' : 'todo'
    const detail = state === 'failed' ? (outcome?.error ?? item.detail) : state === 'skipped' ? 'non effectuée' : item.detail
    return { title: item.title, detail, state }
  })

  let summary: ReactNode = null
  if (outcome && !outcome.error) {
    summary = (
      <div className="result-ok">
        <Icon name="circle-check" size={20} />
        <div>Clé renouvelée : le serveur n'accepte plus l'ancienne.</div>
      </div>
    )
  } else if (failedAt !== -1 && failedAt < 3) {
    summary = (
      <div className="safe-box">
        <Icon name="shield-check" size={20} />
        <div>
          <div className="safe-title">Rien n'a été perdu</div>
          <div className="safe-detail">
            La nouvelle ligne a été retirée du fichier dédié et la nouvelle clé supprimée.
            <br />
            Le tracker continue avec la clé actuelle ; ton authorized_keys n'a pas été touché.
          </div>
        </div>
      </div>
    )
  }

  const intro =
    failedAt !== -1
      ? `Le renouvellement s'est arrêté à l'étape ${failedAt + 1}.${failedAt < 3 ? ' Ta clé actuelle fonctionne toujours.' : ''}`
      : 'Le tracker remplace la clé de ce serveur lui-même, en quatre étapes :'

  return (
    <KeyModal
      title={`Renouveler la clé de ${view.server.name}`}
      busy={busy}
      onClose={onClose}
      footer={
        outcome ? (
          <button type="button" className="button button-secondary button-large" onClick={onClose}>
            Fermer
          </button>
        ) : (
          <>
            <button type="button" className="button button-secondary button-large" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button type="button" className="button button-primary button-large" onClick={() => void rotate()} disabled={busy}>
              <Icon name="refresh-cw" className={busy ? 'spin' : undefined} />
              {busy ? 'Renouvellement…' : 'Renouveler la clé'}
            </button>
          </>
        )
      }
    >
      <div className="muted-line">{intro}</div>
      <KeySteps steps={steps} />
      {!outcome && <CurrentKey view={view} label="Clé actuelle" />}
      {!outcome && (
        <div className="muted-line">
          <Icon name="shield-check" className="text-ok" />
          Seul le fichier dédié du tracker est modifié. Ton ~/.ssh/authorized_keys n'est jamais touché.
        </div>
      )}
      {summary}
      {error && (
        <div className="result-ko">
          <Icon name="circle-x" size={20} />
          <div>{error}</div>
        </div>
      )}
    </KeyModal>
  )
}

/** Révocation, comme dans SSH Gate : le tracker retire sa ligne du serveur, vérifie le refus, puis efface la clé. */
export function RevokeKeyModal({ view, onClose, onChanged }: KeyModalProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [command] = useState(view.revokeCommand ?? '')

  async function run(action: () => Promise<DeployServerView>) {
    setBusy(true)
    try {
      await action()
      onChanged()
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      useNotice.getState().show('info', 'Commande copiée.')
    } catch (err) {
      showError(err)
    }
  }

  const steps: StepItem[] = [
    { title: 'Retirer la clé du fichier dédié sur le serveur', detail: error ?? `~/${DEDICATED_KEY_FILE}, les autres lignes restent`, state: error ? 'failed' : 'todo' },
    { title: 'Vérifier que le serveur la refuse', detail: error ? 'en attente' : 'une nouvelle connexion avec la clé doit échouer', state: error ? 'skipped' : 'todo' },
    {
      title: 'Effacer la clé privée',
      detail: error ? 'en attente' : 'le serveur reste dans la liste, sans clé : « Installer une clé » pour revenir',
      state: error ? 'skipped' : 'todo',
    },
  ]

  return (
    <KeyModal
      title={`Révoquer la clé de ${view.server.name}`}
      busy={busy}
      onClose={onClose}
      footer={
        error ? (
          <>
            <button type="button" className="button button-secondary button-large" onClick={() => void run(() => api.revokeDeployKey(view.server.id))} disabled={busy}>
              Réessayer
            </button>
            <button type="button" className="button button-danger-solid button-large" onClick={() => void run(() => api.forgetDeployKey(view.server.id))} disabled={busy}>
              <Icon name="trash-2" />
              C'est fait, effacer la clé
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button button-secondary button-large" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button type="button" className="button button-danger-solid button-large" onClick={() => void run(() => api.revokeDeployKey(view.server.id))} disabled={busy}>
              <Icon name="x" />
              {busy ? 'Révocation…' : 'Révoquer la clé'}
            </button>
          </>
        )
      }
    >
      <div className="muted-line">
        {error ? "Le tracker n'a pas pu retirer sa clé du serveur." : "Le tracker n'aura plus accès à ce serveur, pour aucun dépôt. Ton propre accès SSH n'est pas touché."}
      </div>
      <KeySteps steps={steps} />
      {error ? (
        <div className="wizard-section">
          <div className="wizard-section-title">Commande à lancer toi-même sur le serveur</div>
          <div className="oneliner mono">
            <span>{command}</span>
            <button type="button" className="icon-button" onClick={() => void copy()} title="Copier" aria-label="Copier">
              <Icon name="copy" />
            </button>
          </div>
          <div className="muted-line">
            <Icon name="info" />
            Une fois la commande lancée, le tracker efface sa clé privée.
          </div>
        </div>
      ) : (
        <>
          <CurrentKey view={view} label="Clé à révoquer" />
          <div className="muted-line">
            <Icon name="info" />
            Si le serveur ne répond pas, le tracker te donnera la commande à lancer toi-même.
          </div>
        </>
      )}
    </KeyModal>
  )
}
