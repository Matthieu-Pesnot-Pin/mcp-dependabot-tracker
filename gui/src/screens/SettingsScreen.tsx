import { ANALYSIS_LIMITS, type GitHubTokenView, type SaveSettingsBody, type SettingsView } from '@shared/schemas/settings.schema'
import { useEffect, useState } from 'react'
import { AgentTokens } from '../components/AgentTokens'
import { DeployServers } from '../components/deploy/DeployServers'
import { Icon } from '../components/Icon'
import { usePolling } from '../hooks/usePolling'
import { showError, useNotice } from '../store/useNotice'
import { api } from '../utils/api'
import { hrefs } from '../utils/router'

const SETUP_TOKEN_COMMAND = 'claude setup-token'

/** Ligne qui retire le token de déploiement de l'environnement d'un script, après son git pull. */
const UNSET_DEPLOY_TOKEN = 'unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0'

/** Délai pendant lequel un second clic confirme le retrait du token de déploiement. */
const CONFIRM_MS = 4000

/** Date courte : « 14 déc. 2026 ». */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    useNotice.getState().show('info', `${what} copiée.`)
  } catch (err) {
    showError(err)
  }
}

interface GitHubTokenProps {
  title: string
  description: string
  view: GitHubTokenView
  /** Statut affiché sans token enregistré. */
  missing: string
  /** Droits à donner au token. */
  rights: string
  /** Valeur saisie ; null tant qu'un token enregistré n'est pas remplacé. */
  value: string | null
  onChange: (value: string | null) => void
  /** Retrait du token enregistré, absent pour un token qui ne se retire pas. */
  onRemove?: () => Promise<void>
}

/**
 * Token GitHub : enregistré, ses quatre derniers caractères, son compte et son
 * expiration, avec « Remplacer » (et « Retirer », confirmé par un second clic,
 * quand il se retire) ; sinon son statut, les droits à lui donner et le champ.
 */
function GitHubToken({ title, description, view, missing, rights, value, onChange, onRemove }: GitHubTokenProps) {
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
    setConfirming(false)
    await onRemove?.()
  }

  const saved = view.tokenHint !== null
  return (
    <div className="github-token">
      <div className="right-label">{title}</div>
      <div className="right-description">{description}</div>
      {saved && value === null ? (
        <div className="github-token-status">
          <Icon name="circle-check" className="text-ok" />
          <span>
            •••• {view.tokenHint}
            {view.login && ` · compte ${view.login}`}
            {view.expiresAt ? ` · expire le ${shortDate(view.expiresAt)}` : view.login ? ' · sans expiration' : ''}
          </span>
          <span className="spacer" />
          <button type="button" className="link" onClick={() => onChange('')}>
            Remplacer
          </button>
          {onRemove && (
            <button type="button" className="link-danger" onClick={() => void remove()}>
              {confirming ? 'Confirmer le retrait' : 'Retirer'}
            </button>
          )}
        </div>
      ) : (
        <>
          {!saved && (
            <div className="github-token-status">
              <Icon name="circle-alert" className="text-warning" />
              <span className="github-token-missing">{missing}</span>
            </div>
          )}
          <div className="github-token-rights">{rights}</div>
          <input
            className="input mono github-token-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={title}
            placeholder="github_pat_…"
            value={value ?? ''}
            onChange={(event) => onChange(event.target.value)}
          />
        </>
      )}
    </div>
  )
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR')
}

/** Champ d'un token enregistré : ses quatre derniers caractères, et un lien pour le remplacer. */
function TokenField({ hint, value, onChange, label, placeholder }: { hint: string | null; value: string | null; onChange: (value: string | null) => void; label: string; placeholder: string }) {
  if (hint !== null && value === null) {
    return (
      <div className="input token-saved">
        <span className="mono">•••••••••••• {hint}</span>
        <button type="button" className="link" onClick={() => onChange('')}>
          Remplacer
        </button>
      </div>
    )
  }
  return (
    <input
      className="input mono"
      type="password"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** Formulaire des réglages, initialisé depuis les réglages enregistrés. */
function SettingsForm({ view, onSaved }: { view: SettingsView; onSaved: (view: SettingsView) => void }) {
  const [url, setUrl] = useState(view.organizer.url ?? '')
  const [organizerToken, setOrganizerToken] = useState<string | null>(null)
  const [claudeToken, setClaudeToken] = useState<string | null>(view.claude.tokenHint === null ? '' : null)
  const [githubToken, setGithubToken] = useState<string | null>(view.github.tokenHint === null ? '' : null)
  const [deployToken, setDeployToken] = useState<string | null>(view.deploy.tokenHint === null ? '' : null)
  const [analysis, setAnalysis] = useState(view.analysis)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)

  async function save() {
    const body: SaveSettingsBody = { organizerUrl: url.trim(), analysis }
    if (organizerToken?.trim()) body.organizerToken = organizerToken.trim()
    if (claudeToken?.trim()) body.claudeToken = claudeToken.trim()
    if (githubToken?.trim()) body.githubToken = githubToken.trim()
    if (deployToken?.trim()) body.deployToken = deployToken.trim()
    setBusy(true)
    try {
      const saved = await api.saveSettings(body)
      setOrganizerToken(null)
      setClaudeToken(saved.claude.tokenHint === null ? '' : null)
      setGithubToken(saved.github.tokenHint === null ? '' : null)
      setDeployToken(saved.deploy.tokenHint === null ? '' : null)
      onSaved(saved)
      useNotice.getState().show('info', 'Réglages enregistrés.')
    } catch (err) {
      showError(err)
    }
    setBusy(false)
  }

  async function test() {
    setTesting(true)
    try {
      onSaved(await api.testOrganizer())
      useNotice.getState().show('info', "La connexion à l'organizer fonctionne.")
    } catch (err) {
      showError(err)
    }
    setTesting(false)
  }

  /** Retire le token de déploiement aussitôt, sans enregistrer les autres champs en cours de saisie. */
  async function removeDeployToken() {
    try {
      const saved = await api.saveSettings({ organizerUrl: view.organizer.url ?? '', analysis: view.analysis, deployToken: null })
      setDeployToken('')
      onSaved(saved)
      useNotice.getState().show('info', 'Token de déploiement retiré.')
    } catch (err) {
      showError(err)
    }
  }

  const limit = (name: 'maxTurns' | 'maxMinutes', raw: string) => {
    const value = Math.round(Number(raw))
    if (Number.isFinite(value)) setAnalysis({ ...analysis, [name]: Math.min(ANALYSIS_LIMITS[name].max, Math.max(ANALYSIS_LIMITS[name].min, value)) })
  }

  return (
    <>
      <div className="page-head">
        <a className="back" href={hrefs.lastHome()} aria-label="Retour à l'accueil">
          <Icon name="arrow-left" size={20} />
        </a>
        <div className="page-head-text">
          <h1 className="page-title">Réglages</h1>
          <p className="subtitle">Accès à GitHub, serveurs de déploiement, corrections par Claude et agents</p>
        </div>
        <div className="page-actions">
          <button type="button" className="button button-primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>

      <DeployServers />

      <p className="section-label">GitHub — accès aux dépôts</p>
      <div className="panel settings-card">
        <GitHubToken
          title="Token du tracker"
          description="Lit les alertes, clone les dépôts, pousse les corrections et ouvre les pull requests"
          view={view.github}
          missing="Manquant — ni synchronisation, ni audit, ni correction"
          rights="Token à grain fin : Dependabot alerts en lecture, Contents et Pull requests en lecture et écriture"
          value={githubToken}
          onChange={setGithubToken}
        />
        <GitHubToken
          title="Token de déploiement"
          description="Transmis aux scripts de déploiement, pour leur git pull"
          view={view.deploy}
          missing="Absent — le git pull d'un dépôt privé échoue pendant un déploiement"
          rights="Token à grain fin en lecture seule : Contents en lecture, limité aux dépôts que vous déployez"
          value={deployToken}
          onChange={setDeployToken}
          onRemove={removeDeployToken}
        />
      </div>
      <div className="settings-note">
        <span>Dans un script de déploiement, retirez le token après le git pull, pour ne pas le transmettre aux commandes suivantes :</span>
        <button type="button" className="code-chip mono" onClick={() => void copy(UNSET_DEPLOY_TOKEN, 'Ligne')} title="Copier la ligne">
          {UNSET_DEPLOY_TOKEN}
          <Icon name="copy" size={14} />
        </button>
      </div>

      <p className="section-label">Organizer — où Claude dépose son rapport (facultatif)</p>
      <div className="panel settings-card">
        <div className="settings-fields">
          <label className="settings-field">
            <span className="field-label">Adresse du site</span>
            <input className="input" value={url} placeholder="https://organizer.example.com" spellCheck={false} onChange={(event) => setUrl(event.target.value)} />
          </label>
          <div className="settings-field settings-field-narrow">
            <span className="field-label">Token d'agent</span>
            <TokenField hint={view.organizer.tokenHint} value={organizerToken} onChange={setOrganizerToken} label="Token d'agent" placeholder="Paramètres › Agents dans l'organizer" />
          </div>
        </div>
        <div className="settings-status">
          {view.organizer.space ? (
            <>
              <Icon name="circle-check" className="text-ok" />
              <span>
                Connecté à l'espace « {view.organizer.space} » · tâches assignées à {view.organizer.owner}
              </span>
            </>
          ) : (
            <span className="muted">Sans organizer, le rapport de Claude est dans la pull request. Pour le recevoir aussi dans une tâche, indiquez l'adresse du site et un token d'agent, créé dans l'organizer (Paramètres › Agents).</span>
          )}
          <span className="spacer" />
          {view.organizer.tokenHint !== null && (
            <button type="button" className="link" disabled={testing} onClick={() => void test()}>
              {testing ? 'Test…' : 'Tester'}
            </button>
          )}
        </div>
      </div>

      <p className="section-label">Claude — abonnement utilisé pour les corrections</p>
      <div className="panel settings-card">
        <div className="settings-status settings-status-top">
          {view.claude.tokenHint !== null ? (
            <>
              <Icon name="circle-check" className="text-ok" />
              <span>
                Connecté · token enregistré le {day(view.claude.savedAt!)}, valable jusqu'au {day(view.claude.expiresAt!)}
              </span>
              <span className="spacer" />
              {claudeToken === null && (
                <button type="button" className="link" onClick={() => setClaudeToken('')}>
                  Remplacer
                </button>
              )}
            </>
          ) : (
            <>
              <Icon name="circle-alert" className="text-warning" />
              <span>Non connecté — sans Claude, une correction pousse les seules corrections automatiques</span>
            </>
          )}
        </div>
        {claudeToken !== null && (
          <ol className="claude-steps">
            <li>
              <span className="step-number">1</span>
              Sur un poste avec navigateur, lancez
              <button type="button" className="code-chip mono" onClick={() => void copy(SETUP_TOKEN_COMMAND, 'Commande')} title="Copier la commande">
                {SETUP_TOKEN_COMMAND}
                <Icon name="copy" size={14} />
              </button>
            </li>
            <li>
              <span className="step-number">2</span>
              Autorisez l'accès dans le navigateur : le terminal affiche un token valable un an
            </li>
            <li>
              <span className="step-number">3</span>
              Collez-le ici
            </li>
            <li className="claude-token-input">
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="Token Claude"
                placeholder="sk-ant-oat01-…"
                value={claudeToken}
                onChange={(event) => setClaudeToken(event.target.value)}
              />
            </li>
          </ol>
        )}
      </div>

      <p className="section-label">Corrections par Claude</p>
      <div className="panel settings-card">
        <div className="right">
          <div>
            <div className="right-label">Limites d'une session</div>
            <div className="right-description">Claude est lancé dès que les corrections automatiques laissent des vulnérabilités</div>
          </div>
          <div className="limits">
            <input
              className="input number-input"
              type="number"
              min={ANALYSIS_LIMITS.maxTurns.min}
              max={ANALYSIS_LIMITS.maxTurns.max}
              value={analysis.maxTurns}
              aria-label="Tours au plus"
              onChange={(event) => limit('maxTurns', event.target.value)}
            />
            <span className="muted">tours</span>
            <input
              className="input number-input"
              type="number"
              min={ANALYSIS_LIMITS.maxMinutes.min}
              max={ANALYSIS_LIMITS.maxMinutes.max}
              value={analysis.maxMinutes}
              aria-label="Minutes au plus"
              onChange={(event) => limit('maxMinutes', event.target.value)}
            />
            <span className="muted">min</span>
          </div>
        </div>
      </div>

      <AgentTokens />
    </>
  )
}

/** Réglages : serveurs de déploiement, tokens GitHub, connexion à l'organizer, token d'abonnement Claude, limites d'une session de Claude, tokens d'accès des agents. */
export function SettingsScreen() {
  const polled = usePolling('settings', () => api.getSettings(), null, { remember: false })
  const [saved, setSaved] = useState<SettingsView | null>(null)
  const view = saved ?? polled.data

  return (
    <div className="page">
      {view ? (
        <SettingsForm view={view} onSaved={setSaved} />
      ) : (
        <p className={polled.error ? 'error-text' : 'muted'}>{polled.error ?? 'Chargement des réglages…'}</p>
      )}
    </div>
  )
}
