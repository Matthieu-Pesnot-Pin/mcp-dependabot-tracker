import type { AgentTokenView, CreatedAgentTokenResponse } from '@shared/schemas/agent-token.schema'
import { useEffect, useRef, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { showError, useNotice } from '../store/useNotice'
import { api } from '../utils/api'
import { relativeTime } from '../utils/format'
import { Icon } from './Icon'

const POLL_MS = 3000

/** Délai pendant lequel un second clic confirme la révocation. */
const CONFIRM_MS = 4000

function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text)
    useNotice.getState().show('info', done)
  } catch (err) {
    showError(err)
  }
}

/** Champ du nom d'un nouveau token, ouvert en place : Entrée crée, Échap annule. */
function NameField({ onCreated, onCancel }: { onCreated: (created: CreatedAgentTokenResponse) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  async function create() {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      onCreated(await api.createAgentToken(name.trim()))
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  return (
    <div className="token-create">
      <input
        ref={input}
        className="input"
        value={name}
        maxLength={60}
        placeholder="Nom, ex. Claude Code — portable"
        aria-label="Nom du token"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void create()
          if (event.key === 'Escape') onCancel()
        }}
      />
      <button type="button" className="button button-queued" disabled={!name.trim() || busy} onClick={() => void create()}>
        Créer
      </button>
      <button type="button" className="link" onClick={onCancel}>
        Annuler
      </button>
    </div>
  )
}

/** Token qui vient d'être créé, affiché une seule fois, avec la commande qui déclare le mode MCP. */
function CreatedToken({ created, onClose }: { created: CreatedAgentTokenResponse; onClose: () => void }) {
  return (
    <div className="token-created">
      <div className="token-created-head">
        <Icon name="circle-check" className="text-ok" />
        <span>Token « {created.token.name} » créé. Copiez-le maintenant : il ne sera plus affiché.</span>
        <span className="spacer" />
        <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="token-secret">
        <span className="input mono token-secret-value">{created.secret}</span>
        <button type="button" className="button button-secondary" onClick={() => void copy(created.secret, 'Token copié.')}>
          <Icon name="copy" />
          Copier
        </button>
      </div>
      <span className="field-label">Déclarer le MCP dans un projet</span>
      <button type="button" className="code-chip mono token-command" onClick={() => void copy(created.setupCommand, 'Commande copiée.')} title="Copier la commande">
        <span className="token-command-text">{created.setupCommand}</span>
        <Icon name="copy" size={14} />
      </button>
    </div>
  )
}

/** Ligne d'un token : nom, quatre derniers caractères, dates ; « Révoquer » au survol, confirmé par un second clic. */
function TokenRow({ token, onRevoked }: { token: AgentTokenView; onRevoked: () => void }) {
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  async function revoke() {
    if (!confirming) {
      setConfirming(true)
      return
    }
    try {
      await api.revokeAgentToken(token.id)
      onRevoked()
    } catch (err) {
      setConfirming(false)
      showError(err)
    }
  }

  return (
    <div className={`token-row${confirming ? ' is-confirming' : ''}`}>
      <Icon name="key-round" className="token-icon" />
      <div className="token-text">
        <div className="token-name">{token.name}</div>
        <div className="token-meta">
          •••• {token.hint} · créé le {shortDay(token.createdAt)} · {token.lastUsedAt ? `utilisé ${relativeTime(token.lastUsedAt)}` : 'jamais utilisé'}
        </div>
      </div>
      <button type="button" className="token-revoke" onClick={() => void revoke()}>
        {confirming ? 'Confirmer la révocation' : 'Révoquer'}
      </button>
    </div>
  )
}

/** Section des tokens d'accès des agents : un agent déclare le mode MCP avec l'adresse du serveur et l'un d'eux. */
export function AgentTokens() {
  const polled = usePolling('agent-tokens', () => api.listAgentTokens(), POLL_MS)
  const [naming, setNaming] = useState(false)
  const [created, setCreated] = useState<CreatedAgentTokenResponse | null>(null)
  const tokens = polled.data?.tokens ?? []

  return (
    <>
      <div className="section-head">
        <p className="section-label">Accès des agents — outils MCP</p>
        {!naming && (
          <button type="button" className="button button-secondary button-small" onClick={() => setNaming(true)}>
            <Icon name="plus" />
            Nouveau token
          </button>
        )}
      </div>
      {(naming || created || tokens.length > 0) && (
        <div className="panel settings-card">
          {naming && (
            <NameField
              onCancel={() => setNaming(false)}
              onCreated={(result) => {
                setNaming(false)
                setCreated(result)
                polled.reload()
              }}
            />
          )}
          {created && <CreatedToken created={created} onClose={() => setCreated(null)} />}
          {tokens.map((token) => (
            <TokenRow key={token.id} token={token} onRevoked={polled.reload} />
          ))}
        </div>
      )}
      {polled.error && <p className="error-text">{polled.error}</p>}
      <p className="hint">Un agent déclare le MCP avec l'adresse de ce serveur et l'un de ces tokens.</p>
    </>
  )
}
