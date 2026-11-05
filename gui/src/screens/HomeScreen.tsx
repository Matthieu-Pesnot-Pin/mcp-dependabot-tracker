import { pendingAlerts } from '@shared/alerts'
import { searchRepositories } from '@shared/repo-search'
import type { RepoView } from '@shared/schemas/api.schema'
import type { Category } from '@shared/schemas/model.schema'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { CategorySidebar } from '../components/CategorySidebar'
import { Icon } from '../components/Icon'
import { MergedActions } from '../components/MergedActions'
import { SeverityPill } from '../components/Pill'
import { Toggle } from '../components/Toggle'
import { usePolling } from '../hooks/usePolling'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { dayAndTime, plural, SCOPE_LABELS, shortDayAndTime, worstSeverity } from '../utils/format'
import { hrefs, navigate, rememberHomeTab, type HomeTab } from '../utils/router'

const POLL_MS = 3000

/** Clés du navigateur qui retiennent la position des interrupteurs de l'accueil. */
const ONLY_VULNERABLE_KEY = 'dependabot-tracker.only-vulnerable'

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

/** Message de l'accueil quand l'interrupteur écarte tous les dépôts de l'onglet, désigné par `where`. */
function filteredOutMessage(where: string): string {
  return `Aucun dépôt vulnérable ${where}.`
}

/** Paquets sans version corrigée publiée : « à la main », la liste en infobulle. */
function UnfixableNote({ unfixable }: { unfixable: string[] }) {
  if (unfixable.length === 0) return null
  return (
    <span className="cell-mark unfixable-note" title={`Aucune version corrigée publiée, à mettre à jour à la main : ${unfixable.join(', ')}`}>
      <Icon name="wrench" size={14} />à la main
    </span>
  )
}

/**
 * Colonne « Sécurité » : la pastille des alertes Dependabot non corrigées à la
 * main, estompée quand un audit plus récent n'a trouvé aucune vulnérabilité,
 * suivie de « dév. » quand elles ne portent que sur des dépendances de
 * développement et que l'audit de production n'a rien trouvé ; des alertes
 * toutes corrigées à la main gardent une pastille estompée ; sans alerte, la
 * pastille des vulnérabilités du dernier audit de la branche par défaut.
 * « à la main » signale les paquets sans version corrigée.
 */
function SecurityCell({ view }: { view: RepoView }) {
  const { repo, cleanAudit, cleanProductionAudit, auditFindings, unfixable } = view
  const pending = pendingAlerts(repo)
  const all = worstSeverity(repo.alerts)
  if (all && pending.length === 0) {
    return (
      <span className="cell-mark" title="Toutes les alertes sont marquées corrigées à la main.">
        <SeverityPill severity={all} faded>
          {plural(repo.alerts.length, 'alerte')}
        </SeverityPill>
      </span>
    )
  }
  const worst = worstSeverity(pending)
  if (worst) {
    return (
      <>
        <span
          className="cell-mark"
          title={
            cleanAudit
              ? `Le dernier audit (${SCOPE_LABELS[cleanAudit.scope]}) n'a trouvé aucune vulnérabilité : Dependabot n'a pas encore repassé.`
              : 'Alertes Dependabot ouvertes.'
          }
        >
          <SeverityPill severity={worst} faded={cleanAudit !== null}>
            {plural(pending.length, 'alerte')}
          </SeverityPill>
        </span>
        {cleanProductionAudit && (
          <span
            className="cell-mark cell-faint"
            title={`Les alertes ouvertes portent sur des dépendances de développement ; l'audit de production du ${dayAndTime(cleanProductionAudit.at)} n'a trouvé aucune vulnérabilité.`}
          >
            dév.
          </span>
        )}
        <UnfixableNote unfixable={unfixable} />
      </>
    )
  }
  if (auditFindings) {
    return (
      <>
        <span
          className="cell-mark"
          title={`Dependabot ne signale aucune alerte, mais l'audit de la branche par défaut du ${dayAndTime(auditFindings.at)} (${SCOPE_LABELS[auditFindings.scope]}) a trouvé des vulnérabilités : Dependabot n'a pas encore repassé.`}
        >
          <SeverityPill severity={auditFindings.severity}>{plural(auditFindings.count, 'vulnérabilité')}</SeverityPill>
        </span>
        <UnfixableNote unfixable={unfixable} />
      </>
    )
  }
  if (repo.syncError) {
    return (
      <span className="cell-mark cell-shrink status-error" title={repo.syncError}>
        <Icon name="circle-alert" size={14} />
        <span className="cell-ellipsis">Synchronisation impossible</span>
      </span>
    )
  }
  if (!repo.syncedAt) return <span className="cell-faint">Synchronisation…</span>
  return (
    <span className="cell-mark cell-faint" title="Aucune alerte Dependabot ouverte.">
      —
    </span>
  )
}

/**
 * Colonne « Dernier audit » : l'opération en cours, sinon le résultat du
 * dernier audit et sa date ; « Prod. OK » pour un audit des seules dépendances
 * de production sans vulnérabilité. La branche et le périmètre sont en infobulle.
 */
function AuditCell({ view }: { view: RepoView }) {
  const { activeOperation, lastAudit } = view
  if (activeOperation) {
    const repairing = activeOperation.steps.repair === 'running'
    return (
      <span className="cell-mark cell-shrink status-busy">
        <Icon name="loader-circle" size={14} className="spin" />
        <span className="cell-ellipsis">{repairing ? 'Corrections par Claude…' : activeOperation.kind === 'audit' ? 'Audit en cours' : 'Correction en cours'}</span>
      </span>
    )
  }
  if (!lastAudit) {
    return (
      <span className="cell-mark cell-faint" title="Aucun audit.">
        —
      </span>
    )
  }
  const clean = lastAudit.count === 0
  const result = clean ? (lastAudit.scope === 'production' ? 'Prod. OK' : 'OK') : plural(lastAudit.count, 'vulnérabilité')
  return (
    <span className="cell-mark cell-shrink cell-audit" title={`Audit du ${dayAndTime(lastAudit.at)} : ${SCOPE_LABELS[lastAudit.scope]}, branche ${lastAudit.branch}.`}>
      <Icon name={clean ? 'circle-check' : 'triangle-alert'} size={14} className={clean ? 'text-ok' : 'text-warning'} />
      <span className="cell-ellipsis">
        {result} · {shortDayAndTime(lastAudit.at)}
      </span>
    </span>
  )
}

/**
 * Colonne « Suivi » : la pull request du tracker en attente (la liste des pull
 * requests du dépôt quand il y en a plusieurs), la tâche organizer du dernier
 * rapport de Claude tant qu'elle n'est pas terminée, et les marques « file
 * d'attente » et « à déployer », chacune avec son infobulle.
 */
function FollowCell({ view }: { view: RepoView }) {
  const { repo, reportTask } = view
  const pulls = repo.pullRequests
  return (
    <>
      {pulls.length > 0 && (
        <a
          className="cell-mark follow-link"
          href={pulls.length === 1 ? pulls[0].url : pulls[0].url.replace(/\/pull\/\d+$/, '/pulls')}
          target="_blank"
          rel="noreferrer"
          title={`Pull request du tracker en attente :\n${pulls.map((pull) => `#${pull.number} — ${pull.branch}`).join('\n')}`}
        >
          <Icon name="git-pull-request" size={14} />
          {pulls.length === 1 ? `#${pulls[0].number}` : `${pulls.length} PR`}
        </a>
      )}
      {reportTask && (
        <a className="cell-mark follow-link" href={reportTask.url} target="_blank" rel="noreferrer" title={`Tâche du dernier rapport de Claude : ${reportTask.title}`}>
          <Icon name="clipboard-list" size={14} />
          {reportTask.key}
        </a>
      )}
      {repo.queuedAt && (
        <span className="cell-mark follow-mark" title={`Dans la file d'attente depuis le ${dayAndTime(repo.queuedAt)}`} aria-label="Dans la file d'attente">
          <Icon name="list-checks" size={14} />
        </span>
      )}
      {repo.deployPendingAt && (
        <span className="cell-mark follow-mark" title={`À déployer depuis le ${dayAndTime(repo.deployPendingAt)}`} aria-label="À déployer">
          <Icon name="rocket" size={14} />
        </span>
      )}
    </>
  )
}

/** En-tête du tableau des dépôts, aligné sur les colonnes des lignes. */
function RepoTableHead() {
  return (
    <div className="repo-table-head">
      <span>Dépôt</span>
      <span>Sécurité</span>
      <span>Dernier audit</span>
      <span>Suivi</span>
    </div>
  )
}

/**
 * Ligne d'un dépôt de l'accueil : le nom, puis les colonnes « Sécurité »,
 * « Dernier audit » et « Suivi », de largeur fixe, puis les boutons et le
 * chevron. Avec `hoverActions`, les boutons n'apparaissent qu'au survol de la
 * ligne, ou en permanence sur un écran tactile.
 */
function RepoRow({ view, actions, hoverActions }: { view: RepoView; actions: ReactNode; hoverActions: boolean }) {
  return (
    <div className="row row-linked repo-row">
      <a className="repo-name row-link" href={hrefs.repo(view.repo.id)} title={view.repo.id}>
        {view.repo.name}
      </a>
      <div className="repo-cell">
        <SecurityCell view={view} />
      </div>
      <div className="repo-cell">
        <AuditCell view={view} />
      </div>
      <div className="repo-cell repo-follow">
        <FollowCell view={view} />
      </div>
      <div className={`repo-actions${hoverActions ? ' repo-actions-hover' : ''}`}>{actions}</div>
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

/** Date de la plus ancienne pull request en attente d'un dépôt. */
function oldestPullRequest(view: RepoView): string {
  return view.repo.pullRequests.map((pull) => pull.createdAt).sort()[0] ?? ''
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
      className={`row-action row-action-toggle${queued ? ' is-on' : ''}`}
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

/** Bouton de chaque ligne qui marque le dépôt « à déployer », ou lui retire la marque ; allumé tant qu'il l'a. */
function DeployToggle({ view, onDone }: { view: RepoView; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const repoId = view.repo.id
  const pending = view.repo.deployPendingAt !== null

  async function toggle() {
    setBusy(true)
    try {
      await (pending ? api.unmarkDeployPending(repoId) : api.markDeployPending(repoId))
      onDone()
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  const label = pending ? 'Retirer de « À déployer »' : 'Marquer à déployer'
  return (
    <button
      type="button"
      className={`row-action row-action-toggle${pending ? ' is-on' : ''}`}
      onClick={() => void toggle()}
      disabled={busy}
      title={label}
      aria-label={`${label} : ${repoId}`}
      aria-pressed={pending}
    >
      <Icon name="rocket" size={14} />
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

/** Bouton « Déployé » d'une ligne de l'onglet « À déployer » : il retire la marque du dépôt. */
function DeployedButton({ repoId, onDone }: { repoId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)

  async function deployed() {
    setBusy(true)
    try {
      await api.unmarkDeployPending(repoId)
      onDone()
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  return (
    <button type="button" className="button button-secondary row-button" onClick={() => void deployed()} disabled={busy} title="Retirer de « À déployer »">
      <Icon name="check" size={14} />
      Déployé
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
 * entrée, chacun avec « Traité » ; « PR en attente » liste les dépôts dont une
 * pull request du tracker attend, de la plus ancienne à la plus récente, chacun
 * avec « Mergée » et « Mergée, à déployer » ; « À déployer » liste les dépôts marqués, dans
 * l'ordre de leur marque, chacun avec « Déployé » ; l'onglet « Dépréciés » liste les autres.
 */
export function HomeScreen({ tab, adding, onCloseAdd, onAdd }: { tab: HomeTab; adding: boolean; onCloseAdd: () => void; onAdd: () => void }) {
  const repos = usePolling('repos', api.listRepos, POLL_MS)
  const config = usePolling('config', api.getConfig, null)
  const categories = repos.data?.categories ?? []
  const categoryId = tab.kind === 'category' ? tab.categoryId : null
  const category = categories.find((candidate) => candidate.id === categoryId) ?? null
  const unknownCategory = categoryId !== null && repos.data !== null && category === null
  const [onlyVulnerable, setOnlyVulnerable] = useStoredFlag(ONLY_VULNERABLE_KEY)
  const allViews = repos.data?.repos ?? []
  const tracked = allViews.filter((view) => view.repo.deprecatedAt === null)
  const deprecated = allViews.filter((view) => view.repo.deprecatedAt !== null).sort((a, b) => b.repo.deprecatedAt!.localeCompare(a.repo.deprecatedAt!))
  const showingQueue = tab.kind === 'queue'
  const showingPulls = tab.kind === 'pulls'
  const showingDeploy = tab.kind === 'deploy'
  const showingDeprecated = tab.kind === 'deprecated'
  const inCategory = showingQueue
    ? tracked.filter((view) => view.repo.queuedAt !== null).sort((a, b) => a.repo.queuedAt!.localeCompare(b.repo.queuedAt!))
    : showingPulls
      ? tracked.filter((view) => view.repo.pullRequests.length > 0).sort((a, b) => oldestPullRequest(a).localeCompare(oldestPullRequest(b)))
      : showingDeploy
        ? tracked.filter((view) => view.repo.deployPendingAt !== null).sort((a, b) => a.repo.deployPendingAt!.localeCompare(b.repo.deployPendingAt!))
        : tracked.filter((view) => categoryId === null || view.repo.categoryId === categoryId)
  const views = inCategory.filter((view) => !onlyVulnerable || isVulnerable(view))
  const where = showingQueue
    ? "dans la file d'attente"
    : showingPulls
      ? 'parmi les PR en attente'
      : showingDeploy
        ? 'parmi les dépôts à déployer'
        : categoryId === null
          ? 'parmi vos projets'
          : 'dans cette catégorie'

  useEffect(() => {
    if (showingDeprecated) rememberHomeTab({ kind: 'deprecated' })
    else if (showingQueue) rememberHomeTab({ kind: 'queue' })
    else if (showingPulls) rememberHomeTab({ kind: 'pulls' })
    else if (showingDeploy) rememberHomeTab({ kind: 'deploy' })
    else if (!unknownCategory) rememberHomeTab({ kind: 'category', categoryId })
  }, [showingDeprecated, showingQueue, showingPulls, showingDeploy, categoryId, unknownCategory])

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
          <h1 className="page-title">{showingQueue ? "File d'attente" : showingPulls ? 'PR en attente' : showingDeploy ? 'À déployer' : category ? category.name : 'Tous mes projets'}</h1>
          <div className="filters">
            {category && inCategory.length > 0 && <QueueCategoryButton categoryId={category.id} views={inCategory} onDone={repos.reload} />}
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
            <p>{filteredOutMessage(where)}</p>
          </div>
        )}
        {repos.data && showingQueue && inCategory.length === 0 && (
          <div className="panel empty">
            <p>La file d'attente est vide : ajoutez-y un dépôt avec le bouton de file de sa ligne.</p>
          </div>
        )}
        {repos.data && showingPulls && inCategory.length === 0 && (
          <div className="panel empty">
            <p>Aucune pull request en attente : une correction aboutie y place son dépôt jusqu'à la fusion.</p>
          </div>
        )}
        {repos.data && showingDeploy && inCategory.length === 0 && (
          <div className="panel empty">
            <p>Aucun dépôt à déployer : marquez-en un avec le bouton fusée de sa ligne, ou depuis l'écran du dépôt.</p>
          </div>
        )}
        {repos.data && !showingQueue && !showingPulls && !showingDeploy && !unknownCategory && inCategory.length === 0 && (
          <div className="panel empty">
            <p>{categoryId === null ? 'Aucun dépôt suivi.' : 'Aucun dépôt dans cette catégorie.'}</p>
            <button type="button" className="button button-primary" onClick={onAdd}>
              <Icon name="plus" />
              Ajouter un dépôt
            </button>
          </div>
        )}
        {views.length > 0 && (
          <div className="panel list repo-table">
            <RepoTableHead />
            {views.map((view) => (
              <RepoRow
                key={view.repo.id}
                view={view}
                hoverActions={!showingQueue && !showingPulls && !showingDeploy}
                actions={
                  showingQueue ? (
                    <DoneButton repoId={view.repo.id} onDone={repos.reload} />
                  ) : showingPulls ? (
                    <MergedActions repoId={view.repo.id} onDone={repos.reload} compact />
                  ) : showingDeploy ? (
                    <DeployedButton repoId={view.repo.id} onDone={repos.reload} />
                  ) : (
                    <>
                      <QueueToggle view={view} onDone={repos.reload} />
                      <DeployToggle view={view} onDone={repos.reload} />
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
