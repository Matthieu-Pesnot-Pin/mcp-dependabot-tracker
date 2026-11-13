import type { DeployServerBody, DeployServerView, KeyFileStatus } from '@shared/schemas/deploy.schema'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { showError, useNotice } from '../../store/useNotice'
import { api } from '../../utils/api'
import { Icon, type IconName } from '../Icon'

/** Fichier de clés du tracker sur le serveur, relatif au dossier personnel. */
const DEDICATED_KEY_FILE = '.ssh/authorized_keys.d/dependabot-tracker'

export type WizardStep = 'form' | 'key' | 'test'

const STEPS: { step: WizardStep; label: string }[] = [
  { step: 'form', label: 'Serveur' },
  { step: 'key', label: 'Installation' },
  { step: 'test', label: 'Test' },
]

function Stepper({ step }: { step: WizardStep }) {
  const current = STEPS.findIndex((item) => item.step === step)
  return (
    <div className="stepper">
      {STEPS.map((item, index) => (
        <span key={item.step} className="stepper-item">
          {index > 0 && <span className="stepper-line" />}
          <span className={`stepper-step${index < current ? ' is-done' : index === current ? ' is-active' : ''}`}>
            <span className="stepper-dot">{index < current ? <Icon name="check" size={12} /> : index + 1}</span>
            {item.label}
          </span>
        </span>
      ))}
    </div>
  )
}

function CheckRow({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <div className="check-row">
      <Icon name={ok ? 'circle-check' : 'triangle-alert'} size={20} className={ok ? 'text-ok' : 'text-warning'} />
      <div>
        <div className="check-title">{title}</div>
        <div className="check-detail">{detail}</div>
      </div>
    </div>
  )
}

function TestResult({ fingerprint, cwd, keyFile }: { fingerprint: string; cwd: string; keyFile: KeyFileStatus }) {
  return (
    <>
      <div className="check-list">
        <CheckRow ok title="Connexion établie" detail={`empreinte du serveur ${fingerprint} enregistrée · shell ouvert dans ${cwd}`} />
        {keyFile.inDedicatedFile &&
          (keyFile.allowedFrom && !keyFile.restrictError ? (
            <CheckRow ok title="Clé limitée à l'adresse du tracker" detail={`from="${keyFile.allowedFrom}" sur sa ligne : l'adresse vue par le serveur pendant le test`} />
          ) : (
            <CheckRow ok={false} title="Clé non limitée à une adresse" detail={keyFile.restrictError ?? "Aucune limite d'adresse sur sa ligne."} />
          ))}
        {keyFile.inDedicatedFile ? (
          <CheckRow ok title="Fichier dédié en place" detail={`~/${DEDICATED_KEY_FILE} · ton authorized_keys n'a pas été touché`} />
        ) : (
          <CheckRow
            ok={false}
            title="Clé hors du fichier dédié"
            detail={`Elle n'est pas dans ~/${DEDICATED_KEY_FILE} : la limite d'adresse n'est pas posée. Colle la commande d'installation pour l'activer.`}
          />
        )}
        {keyFile.inAuthorizedKeys && (
          <CheckRow
            ok={false}
            title="Clé aussi présente dans ~/.ssh/authorized_keys"
            detail="Le tracker ne modifie jamais ce fichier : retires-en cette ligne toi-même, sinon la clé reste valable depuis n'importe quelle adresse."
          />
        )}
      </div>
      {keyFile.allowedFrom && (
        <div className="muted-line">
          <Icon name="info" />
          <span>
            Si l'adresse du tracker change, seul son accès est refusé :
            <br />
            recolle alors la commande d'installation.
          </span>
        </div>
      )}
    </>
  )
}

function DoesRow({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="does-row">
      <Icon name={icon} />
      {children}
    </div>
  )
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text)
    useNotice.getState().show('info', done)
  } catch (err) {
    showError(err)
  }
}

function CopyButton({ value, compact = false }: { value: string; compact?: boolean }) {
  return compact ? (
    <button type="button" className="icon-button" onClick={() => void copy(value, 'Clé copiée.')} title="Copier" aria-label="Copier">
      <Icon name="copy" />
    </button>
  ) : (
    <button type="button" className="button button-secondary button-copy" onClick={() => void copy(value, 'Commande copiée.')}>
      <Icon name="copy" size={14} />
      Copier
    </button>
  )
}

interface ServerWizardProps {
  /** Dépôt auquel un nouveau serveur est attaché. */
  repoId: string
  /** Serveur existant, ouvert à `step`, ou null pour en connecter un nouveau. */
  server: DeployServerView | null
  step: WizardStep
  onClose: () => void
  /** Serveur enregistré ou testé : la vue du déploiement se relit. */
  onChanged: () => void
  /** « Écrire le script », à la fin d'un test réussi. */
  onWriteScript: () => void
}

/** Connexion d'un serveur en trois étapes, comme dans SSH Gate : saisie, commande d'installation, test. */
export function ServerWizard({ repoId, server: initial, step: initialStep, onClose, onChanged, onWriteScript }: ServerWizardProps) {
  const [view, setView] = useState<DeployServerView | null>(initial)
  const [step, setStep] = useState<WizardStep>(initial ? initialStep : 'form')
  const [fields, setFields] = useState<DeployServerBody>(
    initial
      ? { name: initial.server.name, host: initial.server.host, port: initial.server.port, username: initial.server.username }
      : { name: '', host: '', port: 22, username: '' }
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [result, setResult] = useState<{ fingerprint: string; cwd: string; keyFile: KeyFileStatus } | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  async function saveFields(event?: FormEvent) {
    event?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      let saved: DeployServerView
      if (view) {
        saved = await api.updateDeployServer(view.server.id, fields)
      } else {
        saved = await api.createDeployServer(fields)
        await api.setRepoDeployServer(repoId, saved.server.id)
      }
      setView(saved)
      onChanged()
      setStep('key')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    if (!view) return
    setBusy(true)
    setError(null)
    setResult(null)
    setStep('test')
    try {
      const outcome = await api.testDeployServer(view.server.id)
      setView(outcome.server)
      onChanged()
      setResult({ fingerprint: outcome.fingerprint, cwd: outcome.cwd, keyFile: outcome.keyFile })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const field = (key: keyof DeployServerBody, label: string, placeholder: string, className = '') => (
    <label className={`wizard-field ${className}`}>
      <span className="field-label">{label}</span>
      <input
        className="input"
        value={fields[key]}
        placeholder={placeholder}
        autoFocus={key === 'name'}
        inputMode={key === 'port' ? 'numeric' : undefined}
        spellCheck={false}
        onChange={(event) => setFields({ ...fields, [key]: key === 'port' ? event.target.value.replace(/\D/g, '') : event.target.value })}
      />
    </label>
  )

  let body: ReactNode
  let footer: ReactNode
  if (step === 'form') {
    body = (
      <form className="wizard-form" onSubmit={(event) => void saveFields(event)}>
        {field('name', 'Nom', 'prod-web', 'is-wide')}
        {field('host', 'Hôte', '10.0.0.12')}
        {field('port', 'Port', '22', 'is-port')}
        {field('username', 'Utilisateur', 'deploy', 'is-wide')}
        <button type="submit" hidden />
      </form>
    )
    footer = (
      <>
        <button type="button" className="button button-secondary button-large" onClick={view ? () => setStep('key') : onClose}>
          {view ? 'Retour' : 'Annuler'}
        </button>
        <button type="button" className="button button-primary button-large" onClick={() => void saveFields()} disabled={busy}>
          {view ? 'Enregistrer' : 'Générer la clé'}
        </button>
      </>
    )
  } else if (step === 'key' && view) {
    body = (
      <>
        <div className="wizard-summary">
          <Icon name="server" size={20} />
          <span>
            {view.server.name} · {view.server.username}@{view.server.host}:{view.server.port}
          </span>
          <button type="button" className="icon-button" title="Modifier" aria-label="Modifier le serveur" onClick={() => setStep('form')}>
            <Icon name="pencil" size={18} />
          </button>
        </div>
        <div className="wizard-section">
          <div className="wizard-section-title">
            Commande d'installation
            <CopyButton value={view.installCommand ?? ''} />
          </div>
          <div className="keybox mono">{view.installCommand}</div>
          <div className="key-caption">
            <span>Une seule ligne, à coller dans une session ouverte sur le serveur en tant que {view.server.username}.</span>
            <button type="button" className="link" onClick={() => setShowKey(!showKey)}>
              {showKey ? 'Masquer la clé' : 'Clé publique seule'}
            </button>
          </div>
          {showKey && (
            <div className="oneliner mono">
              <span>{view.server.publicKey}</span>
              <CopyButton value={view.server.publicKey ?? ''} compact />
            </div>
          )}
        </div>
        <div className="wizard-section">
          <div className="wizard-section-title">Ce qu'elle fait</div>
          <DoesRow icon="file-key">Écrit la clé dans authorized_keys.d/dependabot-tracker, limitée par restrict</DoesRow>
          <DoesRow icon="settings">Fait lire ce fichier à sshd, en plus de ~/.ssh/authorized_keys (sudo)</DoesRow>
          <DoesRow icon="shield-check">Vérifie la configuration avant de recharger sshd, et s'arrête si elle est invalide</DoesRow>
        </div>
        <div className="callout-warn">
          <Icon name="triangle-alert" size={18} />
          <div>
            Ton fichier ~/.ssh/authorized_keys n'est pas modifié.
            <br />
            Garde quand même ta session ouverte jusqu'au test réussi.
          </div>
        </div>
        <div className="muted-line">
          <Icon name="lock" />
          La clé privée reste chiffrée dans le tracker. Elle n'est jamais affichée.
        </div>
      </>
    )
    footer = (
      <>
        <button type="button" className="button button-secondary button-large" onClick={onClose}>
          Plus tard
        </button>
        <button type="button" className="button button-primary button-large" onClick={() => void test()} disabled={busy}>
          Tester la connexion
        </button>
      </>
    )
  } else {
    body = busy ? (
      <div className="muted-line">
        <Icon name="loader-circle" className="spin" />
        Connexion à {view?.server.host}…
      </div>
    ) : result ? (
      <TestResult {...result} />
    ) : (
      <div className="result-ko">
        <Icon name="circle-x" size={20} />
        <div>{error}</div>
      </div>
    )
    footer = result ? (
      <>
        <button type="button" className="button button-secondary button-large" onClick={onClose}>
          Terminer
        </button>
        <button type="button" className="button button-primary button-large" onClick={onWriteScript}>
          Écrire le script
        </button>
      </>
    ) : (
      <>
        <button type="button" className="button button-secondary button-large" onClick={() => setStep('key')} disabled={busy}>
          Retour à l'installation
        </button>
        <button type="button" className="button button-primary button-large" onClick={() => void test()} disabled={busy}>
          Réessayer
        </button>
      </>
    )
  }

  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="modal modal-wizard" role="dialog" aria-label={initial ? `Serveur ${initial.server.name}` : 'Connecter un serveur'}>
        <div className="wizard-head">
          <h2 className="wizard-title">{initial ? initial.server.name : 'Connecter un serveur'}</h2>
          <button type="button" className="icon-button" onClick={onClose} title="Fermer" aria-label="Fermer">
            <Icon name="x" size={20} />
          </button>
        </div>
        <Stepper step={step} />
        <div className="wizard-body">
          {body}
          {error && step === 'form' && (
            <div className="result-ko">
              <Icon name="circle-x" size={20} />
              <div>{error}</div>
            </div>
          )}
        </div>
        <div className="wizard-foot">{footer}</div>
      </div>
    </div>
  )
}
