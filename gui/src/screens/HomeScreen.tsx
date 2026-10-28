import type { RepoView } from '@shared/schemas/api.schema'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { SeverityPill } from '../components/Pill'
import { usePolling } from '../hooks/usePolling'
import { api } from '../utils/api'
import { plural, worstSeverity } from '../utils/format'
import { hrefs, navigate } from '../utils/router'

const POLL_MS = 3000

/** État d'un dépôt en bout de ligne : une seule information, la plus utile. */
function RepoStatus({ view }: { view: RepoView }) {
  const { repo, activeOperation } = view
  if (activeOperation) {
    return (
      <span className="status status-busy">
        <Icon name="loader-circle" className="spin" />
        Correction en cours
      </span>
    )
  }
  const worst = worstSeverity(repo)
  if (worst) return <SeverityPill severity={worst}>{plural(repo.alerts.length, 'alerte')}</SeverityPill>
  if (repo.syncError) {
    return (
      <span className="status status-error" title={repo.syncError}>
        <Icon name="circle-alert" />
        Synchronisation impossible
      </span>
    )
  }
  if (!repo.syncedAt) return <span className="status status-muted">Synchronisation…</span>
  return (
    <span className="status status-muted">
      <Icon name="circle-check" className="text-ok" />À jour
    </span>
  )
}

function AddRepoModal({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (value.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const view = await api.addRepo(value.trim())
      onClose()
      navigate(hrefs.repo(view.repo.id))
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit} aria-label="Ajouter un dépôt">
        <h2 className="modal-title">Ajouter un dépôt</h2>
        <input
          ref={inputRef}
          className="input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="propriétaire/dépôt ou lien GitHub"
          spellCheck={false}
        />
        {error ? <p className="field-error">{error}</p> : <p className="field-hint">L'agent pourra seulement lancer un audit. Modifiable ensuite.</p>}
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="button button-primary" disabled={busy || value.trim() === ''}>
            {busy ? 'Ajout…' : 'Ajouter'}
          </button>
        </div>
      </form>
    </div>
  )
}

/** Accueil : les dépôts suivis, du plus exposé au moins exposé. */
export function HomeScreen({ adding, onCloseAdd, onAdd }: { adding: boolean; onCloseAdd: () => void; onAdd: () => void }) {
  const repos = usePolling('repos', api.listRepos, POLL_MS)
  const config = usePolling('config', api.getConfig, null)

  return (
    <div className="page">
      <h1 className="page-title">Dépôts</h1>
      {config.data && !config.data.githubConfigured && (
        <p className="banner banner-error">
          <Icon name="triangle-alert" />
          GITHUB_TOKEN n'est pas défini : déclarez un token GitHub dans le bloc env du serveur.
        </p>
      )}
      {repos.error && !repos.data && <p className="banner banner-error">{repos.error}</p>}
      {repos.data && repos.data.repos.length === 0 && (
        <div className="panel empty">
          <p>Aucun dépôt suivi.</p>
          <button type="button" className="button button-primary" onClick={onAdd}>
            <Icon name="plus" />
            Ajouter un dépôt
          </button>
        </div>
      )}
      {repos.data && repos.data.repos.length > 0 && (
        <div className="panel list">
          {repos.data.repos.map((view) => (
            <a key={view.repo.id} className="row" href={hrefs.repo(view.repo.id)}>
              <span className="row-title">{view.repo.id}</span>
              <RepoStatus view={view} />
              <Icon name="chevron-right" className="row-chevron" />
            </a>
          ))}
        </div>
      )}
      {adding && <AddRepoModal onClose={onCloseAdd} />}
    </div>
  )
}
