import { pendingAlerts } from '@shared/alerts'
import { searchRepositories } from '@shared/repo-search'
import type { RepoView } from '@shared/schemas/api.schema'
import type { Category, Repo } from '@shared/schemas/model.schema'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { CategorySidebar } from '../components/CategorySidebar'
import { Icon } from '../components/Icon'
import { SeverityPill } from '../components/Pill'
import { Toggle } from '../components/Toggle'
import { usePolling } from '../hooks/usePolling'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { dayAndTime, plural, SCOPE_LABELS, worstSeverity } from '../utils/format'
import { hrefs, navigate, rememberHomeTab, type HomeTab } from '../utils/router'

const POLL_MS = 3000

/** Clés du navigateur qui retiennent la position des interrupteurs de l'accueil. */
const ONLY_VULNERABLE_KEY = 'dependabot-tracker.only-vulnerable'
const ONLY_PENDING_PR_KEY = 'dependabot-tracker.only-pending-pr'

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // Stockage indisponible : la position vaut pour cette visite seulement.
  }
}

/** Interrupteur de l'accueil dont le navigateur retient la position. */
function useStoredFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readFlag(key))
  return [
    value,
    (next: boolean) => {
      setValue(next)
      writeFlag(key, next)
    },
  ]
}

/**
 * Dépôt réellement vulnérable : des paquets sans version corrigée au dernier
 * audit, des alertes non corrigées à la main que cet audit ne contredit pas, ou
 * des vulnérabilités trouvées par l'audit alors que Dependabot ne signale rien.
 */
function isVulnerable(view: RepoView): boolean {
  return view.unfixable.length > 0 || view.auditFindings !== null || (pendingAlerts(view.repo).length > 0 && view.cleanAudit === null)
}

/** Paquets sans version corrigée publiée, signalés devant la pastille. */
function UnfixableNote({ unfixable }: { unfixable: string[] }) {
  if (unfixable.length === 0) return null
  return (
    <span className="unfixable-note" title={`Aucune version corrigée publiée : ${unfixable.join(', ')}`}>
      <Icon name="triangle-alert" />
      {plural(unfixable.length, 'sans correctif', 'sans correctif')}
    </span>
  )
}

/**
 * Pull requests du tracker en attente sur un dépôt : un lien vers la pull
 * request, ou vers la liste des pull requests du dépôt quand il y en a plusieurs.
 */
function PendingPullRequests({ repo }: { repo: Repo }) {
  const pulls = repo.pullRequests
  if (pulls.length === 0) return null
  const single = pulls.length === 1
  return (
    <a
      className="pr-note"
      href={single ? pulls[0].url : pulls[0].url.replace(/\/pull\/\d+$/, '/pulls')}
      target="_blank"
      rel="noreferrer"
      title={pulls.map((pull) => `#${pull.number} — ${pull.branch}`).join('\n')}
    >
      <Icon name="git-pull-request" size={14} />
      {single ? `PR #${pulls[0].number} en attente` : `${pulls.length} PR en attente`}
    </a>
  )
}

/** Message de l'accueil quand les interrupteurs écartent tous les dépôts de l'onglet, désigné par `where`. */
function filteredOutMessage(onlyVulnerable: boolean, onlyPendingPr: boolean, where: string): string {
  if (onlyVulnerable && onlyPendingPr) return `Aucun dépôt vulnérable avec une PR en attente ${where}.`
  if (onlyPendingPr) return `Aucune PR en attente ${where}.`
  return `Aucun dépôt vulnérable ${where}.`
}

/** Tâche organizer de la dernière analyse par Claude, tant qu'elle n'est pas terminée ; s'ouvre sur le site de l'organizer. */
function AnalysisTaskNote({ view }: { view: RepoView }) {
  const task = view.analysisTask
  if (!task) return null
  return (
    <a className="pr-note" href={task.url} target="_blank" rel="noreferrer" title={task.title}>
      <Icon name="list-checks" size={14} />
      Tâche {task.key}
      <Icon name="external-link" size={12} />
    </a>
  )
}

/**
 * État d'un dépôt, en deux parties : `note`, l'information la plus utile, à la
 * suite de la PR et de la tâche ; `pill`, la pastille d'alertes, devant les
 * boutons de la ligne. Des alertes toutes corrigées à la main, ou un audit sans
 * vulnérabilité plus récent qu'elles, estompent leur pastille ; des
 * vulnérabilités que l'audit a trouvées sans alerte Dependabot ont leur propre
 * pastille ; des paquets sans version corrigée sont signalés devant elles.
 */
function repoStatus(view: RepoView): { note: ReactNode; pill: ReactNode } {
  const { repo, activeOperation, cleanAudit, auditFindings, unfixable } = view
  if (activeOperation) {
    const analysing = activeOperation.steps.analysis === 'running'
    const repairing = activeOperation.steps.repair === 'running'
    return {
      note: (
        <span className="status status-busy">
          <Icon name="loader-circle" className="spin" />
          {analysing ? 'Analyse par Claude…' : repairing ? 'Corrections par Claude…' : activeOperation.kind === 'audit' ? 'Audit en cours' : 'Correction en cours'}
        </span>
      ),
      pill: null,
    }
  }
  const pending = pendingAlerts(repo)
  const all = worstSeverity(repo.alerts)
  if (all && pending.length === 0) {
    return {
      note: (
        <span className="status status-clean" title="Toutes les alertes sont marquées corrigées à la main.">
          <Icon name="circle-check" className="text-ok" />
          Corrigé à la main
        </span>
      ),
      pill: (
        <SeverityPill severity={all} faded>
          {plural(repo.alerts.length, 'alerte')}
        </SeverityPill>
      ),
    }
  }
  const worst = worstSeverity(pending)
  if (worst && cleanAudit) {
    return {
      note: (
        <span className="status status-clean" title={`Le dernier audit (${SCOPE_LABELS[cleanAudit.scope]}) n'a trouvé aucune vulnérabilité : Dependabot n'a pas encore repassé.`}>
          <Icon name="circle-check" className="text-ok" />
          Audit OK le {dayAndTime(cleanAudit.at)}
        </span>
      ),
      pill: (
        <SeverityPill severity={worst} faded>
          {plural(pending.length, 'alerte')}
        </SeverityPill>
      ),
    }
  }
  if (worst) {
    return {
      note: null,
      pill: (
        <>
          <UnfixableNote unfixable={unfixable} />
          <SeverityPill severity={worst}>{plural(pending.length, 'alerte')}</SeverityPill>
        </>
      ),
    }
  }
  if (auditFindings) {
    return {
      note: (
        <span
          className="status status-clean"
          title={`Dependabot ne signale aucune alerte, mais le dernier audit de la branche par défaut (${SCOPE_LABELS[auditFindings.scope]}) a trouvé des vulnérabilités : Dependabot n'a pas encore repassé.`}
        >
          <Icon name="triangle-alert" className="text-warning" />
          Audit du {dayAndTime(auditFindings.at)}
        </span>
      ),
      pill: (
        <>
          <UnfixableNote unfixable={unfixable} />
          <SeverityPill severity={auditFindings.severity}>{plural(auditFindings.count, 'vulnérabilité')}</SeverityPill>
        </>
      ),
    }
  }
  if (repo.syncError) {
    return {
      note: (
        <span className="status status-error" title={repo.syncError}>
          <Icon name="circle-alert" />
          Synchronisation impossible
        </span>
      ),
      pill: null,
    }
  }
  if (!repo.syncedAt) return { note: <span className="status status-muted">Synchronisation…</span>, pill: null }
  return {
    note: (
      <span className="status status-muted">
        <Icon name="circle-check" className="text-ok" />À jour
      </span>
    ),
    pill: null,
  }
}

/**
 * Ligne d'un dépôt de l'accueil, sur deux niveaux : le nom seul sur la première
 * ligne ; sur la seconde, la PR, la tâche et l'état à gauche, la pastille et
 * les boutons à droite. Le chevron est centré sur la hauteur de la ligne.
 */
function RepoRow({ view, actions }: { view: RepoView; actions: ReactNode }) {
  const { note, pill } = repoStatus(view)
  return (
    <div className="row row-linked row-repo">
      <div className="row-body">
        <a className="row-title row-link" href={hrefs.repo(view.repo.id)}>
          {view.repo.id}
        </a>
        <div className="row-details">
          <div className="row-meta">
            <PendingPullRequests repo={view.repo} />
            <AnalysisTaskNote view={view} />
            {note}
          </div>
          <div className="row-end">
            {pill && <span className="row-status">{pill}</span>}
            {actions}
          </div>
        </div>
      </div>
      <Icon name="chevron-right" className="row-chevron" />
    </div>
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

/** Bouton de chaque ligne qui met le dépôt dans la file d'attente, ou l'en retire ; allumé tant que le dépôt y est. */
function QueueToggle({ view, onDone }: { view: RepoView; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const repoId = view.repo.id
  const queued = view.repo.queuedAt !== null

  async function toggle() {
    setBusy(true)
    try {
      await (queued ? api.unqueueRepo(repoId) : api.queueRepo(repoId))
      onDone()
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  const label = queued ? "Retirer de la file d'attente" : "Ajouter à la file d'attente"
  return (
    <button
      type="button"
      className={`row-action row-action-queue${queued ? ' is-on' : ''}`}
      onClick={() => void toggle()}
      disabled={busy}
      title={label}
      aria-label={`${label} : ${repoId}`}
      aria-pressed={queued}
    >
      <Icon name={queued ? 'list-check' : 'list-plus'} size={14} />
    </button>
  )
}

/** Bouton d'une catégorie qui met tous ses dépôts dans la file d'attente ; inactif quand ils y sont tous. */
function QueueCategoryButton({ categoryId, views, onDone }: { categoryId: string; views: RepoView[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const remaining = views.filter((view) => view.repo.queuedAt === null).length

  async function queueAll() {
    setBusy(true)
    try {
      await api.queueCategory(categoryId)
      onDone()
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="button button-secondary row-button"
      onClick={() => void queueAll()}
      disabled={busy || remaining === 0}
      title={remaining === 0 ? "Tous les dépôts de la catégorie sont dans la file d'attente." : `${plural(remaining, 'dépôt')} à ajouter à la file d'attente`}
    >
      <Icon name="list-plus" size={14} />
      Tout ajouter à la file
    </button>
  )
}

/** Bouton « Traité » d'une ligne de la file d'attente : il retire le dépôt de la file. */
function DoneButton({ repoId, onDone }: { repoId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)

  async function done() {
    setBusy(true)
    try {
      await api.unqueueRepo(repoId)
      onDone()
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  return (
    <button type="button" className="button button-secondary row-button" onClick={() => void done()} disabled={busy} title="Retirer de la file d'attente">
      <Icon name="check" size={14} />
      Traité
    </button>
  )
}

/** Bouton de chaque ligne qui marque le dépôt déprécié ; il ne reste alors que dans l'onglet « Dépréciés ». */
function DeprecateButton({ repoId, onDone }: { repoId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)

  async function deprecate() {
    setBusy(true)
    try {
      await api.deprecateRepo(repoId)
      onDone()
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="row-action"
      onClick={() => void deprecate()}
      disabled={busy}
      title="Marquer comme déprécié"
      aria-label={`Marquer ${repoId} comme déprécié`}
    >
      <Icon name="archive" size={14} />
    </button>
  )
}

/** Bouton « Rétablir » d'un dépôt déprécié : il retrouve sa catégorie, sa synchronisation et ses audits. */
function RestoreButton({ repoId, onDone }: { repoId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)

  async function restore() {
    setBusy(true)
    try {
      await api.restoreRepo(repoId)
      onDone()
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  return (
    <button type="button" className="button button-secondary row-button" onClick={() => void restore()} disabled={busy}>
      <Icon name="archive-restore" size={14} />
      {busy ? 'Rétablissement…' : 'Rétablir'}
    </button>
  )
}

/** Onglet « Dépréciés » : les dépôts dépréciés, du plus récent au plus ancien, chacun avec « Rétablir ». */
function DeprecatedList({ views, onChanged }: { views: RepoView[]; onChanged: () => void }) {
  if (views.length === 0) {
    return (
      <div className="panel empty">
        <p>Aucun dépôt déprécié.</p>
      </div>
    )
  }
  return (
    <div className="panel list">
      {views.map((view) => (
        <div key={view.repo.id} className="row row-linked">
          <a className="row-title row-link deprecated-title" href={hrefs.repo(view.repo.id)}>
            {view.repo.id}
          </a>
          <span className="status status-muted">Déprécié le {dayAndTime(view.repo.deprecatedAt!)}</span>
          <RestoreButton repoId={view.repo.id} onDone={onChanged} />
          <Icon name="chevron-right" className="row-chevron" />
        </div>
      ))}
    </div>
  )
}

/**
 * Accueil : la barre des catégories, et les dépôts de l'onglet choisi. Une
 * catégorie, ou tous les projets, liste ses dépôts non dépréciés du plus exposé
 * au moins exposé ; la file d'attente liste les siens dans l'ordre de leur
 * entrée, chacun avec « Traité » ; l'onglet « Dépréciés » liste les autres.
 */
export function HomeScreen({ tab, adding, onCloseAdd, onAdd }: { tab: HomeTab; adding: boolean; onCloseAdd: () => void; onAdd: () => void }) {
  const repos = usePolling('repos', api.listRepos, POLL_MS)
  const config = usePolling('config', api.getConfig, null)
  const categories = repos.data?.categories ?? []
  const categoryId = tab.kind === 'category' ? tab.categoryId : null
  const category = categories.find((candidate) => candidate.id === categoryId) ?? null
  const unknownCategory = categoryId !== null && repos.data !== null && category === null
  const [onlyVulnerable, setOnlyVulnerable] = useStoredFlag(ONLY_VULNERABLE_KEY)
  const [onlyPendingPr, setOnlyPendingPr] = useStoredFlag(ONLY_PENDING_PR_KEY)
  const allViews = repos.data?.repos ?? []
  const tracked = allViews.filter((view) => view.repo.deprecatedAt === null)
  const deprecated = allViews.filter((view) => view.repo.deprecatedAt !== null).sort((a, b) => b.repo.deprecatedAt!.localeCompare(a.repo.deprecatedAt!))
  const showingQueue = tab.kind === 'queue'
  const showingDeprecated = tab.kind === 'deprecated'
  const inCategory = showingQueue
    ? tracked.filter((view) => view.repo.queuedAt !== null).sort((a, b) => a.repo.queuedAt!.localeCompare(b.repo.queuedAt!))
    : tracked.filter((view) => categoryId === null || view.repo.categoryId === categoryId)
  const views = inCategory.filter((view) => (!onlyVulnerable || isVulnerable(view)) && (!onlyPendingPr || view.repo.pullRequests.length > 0))
  const where = showingQueue ? "dans la file d'attente" : categoryId === null ? 'parmi vos projets' : 'dans cette catégorie'

  useEffect(() => {
    if (showingDeprecated) rememberHomeTab({ kind: 'deprecated' })
    else if (showingQueue) rememberHomeTab({ kind: 'queue' })
    else if (!unknownCategory) rememberHomeTab({ kind: 'category', categoryId })
  }, [showingDeprecated, showingQueue, categoryId, unknownCategory])

  if (showingDeprecated) {
    return (
      <div className="home">
        {repos.data && <CategorySidebar categories={categories} views={tracked} deprecatedCount={deprecated.length} tab={tab} onChanged={repos.reload} />}
        <div className="page">
          <div className="home-head">
            <h1 className="page-title">Dépréciés</h1>
          </div>
          {repos.error && !repos.data && <p className="banner banner-error">{repos.error}</p>}
          {repos.data && <DeprecatedList views={deprecated} onChanged={repos.reload} />}
        </div>
        {adding && repos.data && <AddRepoModal categories={categories} initialCategory={null} onClose={onCloseAdd} />}
      </div>
    )
  }

  return (
    <div className="home">
      {repos.data && <CategorySidebar categories={categories} views={tracked} deprecatedCount={deprecated.length} tab={tab} onChanged={repos.reload} />}
      <div className="page">
        <div className="home-head">
          <h1 className="page-title">{showingQueue ? "File d'attente" : category ? category.name : 'Tous mes projets'}</h1>
          <div className="filters">
            {category && inCategory.length > 0 && <QueueCategoryButton categoryId={category.id} views={inCategory} onDone={repos.reload} />}
            <label className="filter">
              PR en attente
              <Toggle checked={onlyPendingPr} onChange={setOnlyPendingPr} label="PR en attente" />
            </label>
            <label className="filter">
              Vulnérables seulement
              <Toggle checked={onlyVulnerable} onChange={setOnlyVulnerable} label="Vulnérables seulement" />
            </label>
          </div>
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
            <p>{filteredOutMessage(onlyVulnerable, onlyPendingPr, where)}</p>
          </div>
        )}
        {repos.data && showingQueue && inCategory.length === 0 && (
          <div className="panel empty">
            <p>La file d'attente est vide : ajoutez-y un dépôt avec le bouton de file de sa ligne.</p>
          </div>
        )}
        {repos.data && !showingQueue && !unknownCategory && inCategory.length === 0 && (
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
              <RepoRow
                key={view.repo.id}
                view={view}
                actions={
                  showingQueue ? (
                    <DoneButton repoId={view.repo.id} onDone={repos.reload} />
                  ) : (
                    <>
                      <QueueToggle view={view} onDone={repos.reload} />
                      <DeprecateButton repoId={view.repo.id} onDone={repos.reload} />
                    </>
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
      {adding && repos.data && <AddRepoModal categories={categories} initialCategory={category?.id ?? null} onClose={onCloseAdd} />}
    </div>
  )
}
