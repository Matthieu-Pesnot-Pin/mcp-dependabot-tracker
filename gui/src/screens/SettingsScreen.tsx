import { ANALYSIS_LIMITS, type SaveSettingsBody, type SettingsView } from '@shared/schemas/settings.schema'
import { useState } from 'react'
import { Icon } from '../components/Icon'
import { Toggle } from '../components/Toggle'
import { usePolling } from '../hooks/usePolling'
import { showError, useNotice } from '../store/useNotice'
import { api } from '../utils/api'
import { hrefs } from '../utils/router'

const SETUP_TOKEN_COMMAND = 'claude setup-token'

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
  const [analysis, setAnalysis] = useState(view.analysis)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)

  async function save() {
    const body: SaveSettingsBody = { organizerUrl: url.trim(), analysis }
    if (organizerToken?.trim()) body.organizerToken = organizerToken.trim()
    if (claudeToken?.trim()) body.claudeToken = claudeToken.trim()
    setBusy(true)
    try {
      const saved = await api.saveSettings(body)
      setOrganizerToken(null)
      setClaudeToken(saved.claude.tokenHint === null ? '' : null)
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

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(SETUP_TOKEN_COMMAND)
      useNotice.getState().show('info', 'Commande copiée.')
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
          <p className="subtitle">Analyse par Claude quand npm audit fix ne suffit pas</p>
        </div>
        <div className="page-actions">
          <button type="button" className="button button-primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>

      <p className="section-label">Organizer — où l'agent crée la tâche</p>
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
            <span className="muted">Indiquez l'adresse du site et un token d'agent, créé dans l'organizer (Paramètres › Agents).</span>
          )}
          <span className="spacer" />
          {view.organizer.tokenHint !== null && (
            <button type="button" className="link" disabled={testing} onClick={() => void test()}>
              {testing ? 'Test…' : 'Tester'}
            </button>
          )}
        </div>
      </div>

      <p className="section-label">Claude — abonnement utilisé pour l'analyse</p>
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
              <span>Non connecté — l'analyse ne peut pas démarrer</span>
            </>
          )}
        </div>
        {claudeToken !== null && (
          <ol className="claude-steps">
            <li>
              <span className="step-number">1</span>
              Sur un poste avec navigateur, lancez
              <button type="button" className="code-chip mono" onClick={() => void copyCommand()} title="Copier la commande">
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

      <p className="section-label">Analyse</p>
      <div className="panel settings-card">
        <div className="right">
          <div>
            <div className="right-label">Analyser automatiquement</div>
            <div className="right-description">Dès qu'une correction se termine avec des vulnérabilités restantes</div>
          </div>
          <Toggle checked={analysis.auto} onChange={(auto) => setAnalysis({ ...analysis, auto })} label="Analyser automatiquement" />
        </div>
        <div className="right">
          <div className="right-label">Limites d'une analyse</div>
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
    </>
  )
}

/** Réglages de l'analyse par Claude : connexion à l'organizer, token d'abonnement Claude, déclenchement et limites. */
export function SettingsScreen() {
  const polled = usePolling('settings', () => api.getSettings(), null)
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
