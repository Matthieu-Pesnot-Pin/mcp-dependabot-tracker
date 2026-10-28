import { searchRepositories } from '@shared/repo-search'
import type { RepoView } from '@shared/schemas/api.schema'
import type { Category } from '@shared/schemas/model.schema'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CategorySidebar } from '../components/CategorySidebar'
import { Icon } from '../components/Icon'
import { SeverityPill } from '../components/Pill'
import { Toggle } from '../components/Toggle'
import { usePolling } from '../hooks/usePolling'
import { api } from '../utils/api'
import { dayAndTime, plural, worstSeverity } from '../utils/format'
import { hrefs, navigate, rememberHomeCategory } from '../utils/router'

const POLL_MS = 3000

/** Clé du navigateur qui retient la position de l'interrupteur « Vulnérables seulement ». */
const ONLY_VULNERABLE_KEY = 'dependabot-tracker.only-vulnerable'

function readOnlyVulnerable(): boolean {
  try {
    return localStorage.getItem(ONLY_VULNERABLE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeOnlyVulnerable(value: boolean) {
  try {
    localStorage.setItem(ONLY_VULNERABLE_KEY, String(value))
  } catch {
    // Stockage indisponible : la position vaut pour cette visite seulement.
  }
}

/**
 * État d'un dépôt en bout de ligne : une seule information, la plus utile. Un
 * audit sans vulnérabilité, plus récent que les alertes, estompe leur pastille.
 */
function RepoStatus({ view }: { view: RepoView }) {
  const { repo, activeOperation, cleanAuditAt } = view
  if (activeOperation) {
    return (
      <span className="status status-busy">
        <Icon name="loader-circle" className="spin" />
        Correction en cours
      </span>
    )
  }
  const worst = worstSeverity(repo)
  if (worst && cleanAuditAt) {
    return (
      <span className="status status-clean" title="Le dernier audit n'a trouvé aucune vulnérabilité : Dependabot n'a pas encore repassé.">
        <Icon name="circle-check" className="text-ok" />
        Audit OK le {dayAndTime(cleanAuditAt)}
        <SeverityPill severity={worst} faded>
          {plural(repo.alerts.length, 'alerte')}
        </SeverityPill>
      </span>
    )
  }
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

/**
 * Fenêtre d'ajout : la frappe propose jusqu'à dix dépôts accessibles au token
 * GitHub ; ↑ et ↓ parcourent, Entrée ou un clic reportent le dépôt dans le
 * champ. La catégorie part de celle affichée par l'accueil ; « Ajouter », ou
 * Entrée sans suggestion, ajoute la saisie (`propriétaire/dépôt` ou lien).
 */
function AddRepoModal({ categories, initialCategory, onClose }: { categories: Category[]; initialCategory: string | null; onClose: () => void }) {
  const [value, setValue] = useState('')
  const [categoryId, setCategoryId] = useState(initialCategory)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(0)
  const [listClosed, setListClosed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const addable = usePolling('addable-repos', api.listAddableRepos, null)

  const suggestions = listClosed ? [] : searchRepositories(addable.data?.repositories ?? [], value)
  const activeIndex = Math.min(active, suggestions.length - 1)

  useEffect(() => {
    inputRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function add(repository: string) {
    if (repository.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const view = await api.addRepo(repository.trim(), categoryId)
      onClose()
      navigate(hrefs.repo(view.repo.id))
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  /** Reporte la suggestion dans le champ et ferme la liste, sans ajouter. */
  function pick(repository: string) {
    setValue(repository)
    setError(null)
    setListClosed(true)
    inputRef.current?.focus()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (activeIndex >= 0) pick(suggestions[activeIndex])
    else void add(value)
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape' && suggestions.length > 0) {
      event.stopPropagation()
      setListClosed(true)
      return
    }
    if (suggestions.length === 0 || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    const count = suggestions.length
    setActive((current) => (Math.min(current, count - 1) + step + count) % count)
  }

  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit} aria-label="Ajouter un dépôt">
        <h2 className="modal-title">Ajouter un dépôt</h2>
        <input
          ref={inputRef}
          className="input"
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
            setActive(0)
            setListClosed(false)
          }}
          onKeyDown={onInputKeyDown}
          placeholder="propriétaire/dépôt ou lien GitHub"
          spellCheck={false}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls="repo-suggestions"
          aria-activedescendant={activeIndex >= 0 ? `repo-suggestion-${activeIndex}` : undefined}
        />
        {suggestions.length > 0 && (
          <ul className="suggestions" id="repo-suggestions" role="listbox">
            {suggestions.map((repository, index) => (
              <li
                key={repository}
                id={`repo-suggestion-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={`suggestion${index === activeIndex ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  pick(repository)
                }}
              >
                {repository}
              </li>
            ))}
          </ul>
        )}
        <label className="select-field">
          <Icon name="folder" />
          <select value={categoryId ?? ''} onChange={(event) => setCategoryId(event.target.value === '' ? null : event.target.value)} aria-label="Catégorie">
            <option value="">Sans catégorie</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={14} className="select-chevron" />
        </label>
        {error ? (
          <p className="field-error">{error}</p>
        ) : addable.error ? (
          <p className="field-error">Suggestions indisponibles : {addable.error}</p>
        ) : (
          <p className="field-hint">L'agent pourra seulement lancer un audit. Modifiable ensuite.</p>
        )}
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

/** Accueil : la barre des catégories et les dépôts de la catégorie choisie, du plus exposé au moins exposé. */
export function HomeScreen({ categoryId, adding, onCloseAdd, onAdd }: { categoryId: string | null; adding: boolean; onCloseAdd: () => void; onAdd: () => void }) {
  const repos = usePolling('repos', api.listRepos, POLL_MS)
  const config = usePolling('config', api.getConfig, null)
  const categories = repos.data?.categories ?? []
  const category = categories.find((candidate) => candidate.id === categoryId) ?? null
  const unknownCategory = categoryId !== null && repos.data !== null && category === null
  const [onlyVulnerable, setOnlyVulnerable] = useState(readOnlyVulnerable)
  const inCategory = (repos.data?.repos ?? []).filter((view) => categoryId === null || view.repo.categoryId === categoryId)
  const views = onlyVulnerable ? inCategory.filter((view) => view.repo.alerts.length > 0) : inCategory

  function toggleOnlyVulnerable(value: boolean) {
    setOnlyVulnerable(value)
    writeOnlyVulnerable(value)
  }

  useEffect(() => {
    if (!unknownCategory) rememberHomeCategory(categoryId)
  }, [categoryId, unknownCategory])

  return (
    <div className="home">
      {repos.data && <CategorySidebar categories={categories} views={repos.data.repos} selected={categoryId} onChanged={repos.reload} />}
      <div className="page">
        <div className="home-head">
          <h1 className="page-title">{category ? category.name : 'Tous mes projets'}</h1>
          <label className="filter">
            Vulnérables seulement
            <Toggle checked={onlyVulnerable} onChange={toggleOnlyVulnerable} label="Vulnérables seulement" />
          </label>
        </div>
        {config.data && !config.data.githubConfigured && (
          <p className="banner banner-error">
            <Icon name="triangle-alert" />
            GITHUB_TOKEN n'est pas défini : déclarez un token GitHub dans le bloc env du serveur.
          </p>
        )}
        {repos.error && !repos.data && <p className="banner banner-error">{repos.error}</p>}
        {unknownCategory && (
          <p className="muted">
            Cette catégorie n'existe plus. <a className="link" href={hrefs.home()}>Voir tous les projets</a>.
          </p>
        )}
        {repos.data && !unknownCategory && inCategory.length > 0 && views.length === 0 && (
          <div className="panel empty">
            <p>Aucun dépôt vulnérable {categoryId === null ? 'parmi vos projets' : 'dans cette catégorie'}.</p>
          </div>
        )}
        {repos.data && !unknownCategory && inCategory.length === 0 && (
          <div className="panel empty">
            <p>{categoryId === null ? 'Aucun dépôt suivi.' : 'Aucun dépôt dans cette catégorie.'}</p>
            <button type="button" className="button button-primary" onClick={onAdd}>
              <Icon name="plus" />
              Ajouter un dépôt
            </button>
          </div>
        )}
        {views.length > 0 && (
          <div className="panel list">
            {views.map((view) => (
              <a key={view.repo.id} className="row" href={hrefs.repo(view.repo.id)}>
                <span className="row-title">{view.repo.id}</span>
                <RepoStatus view={view} />
                <Icon name="chevron-right" className="row-chevron" />
              </a>
            ))}
          </div>
        )}
      </div>
      {adding && repos.data && <AddRepoModal categories={categories} initialCategory={category?.id ?? null} onClose={onCloseAdd} />}
    </div>
  )
}
