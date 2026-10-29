import type { RepoView } from '@shared/schemas/api.schema'
import type { Category } from '@shared/schemas/model.schema'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { alertTotals, plural, pullRequestCount } from '../utils/format'
import { hrefs, navigate, type HomeTab } from '../utils/router'
import { Icon, type IconName } from './Icon'
import { SeverityPill } from './Pill'

/** Délai pendant lequel un second clic confirme la suppression d'une catégorie. */
const CONFIRM_MS = 4000

/** Nombre de vulnérabilités d'un ensemble de dépôts, coloré selon la plus grave ; rien sans vulnérabilité. */
function CountPill({ views }: { views: RepoView[] }) {
  const { count, worst } = alertTotals(views)
  if (worst === null) return null
  return (
    <SeverityPill severity={worst} small>
      {count}
    </SeverityPill>
  )
}

/** Nombre de pull requests du tracker en attente dans un ensemble de dépôts ; rien sans pull request. */
function PullRequestPill({ views }: { views: RepoView[] }) {
  const count = pullRequestCount(views.map((view) => view.repo))
  if (count === 0) return null
  return (
    <span className="pill pill-small pill-pr" title={`${plural(count, 'pull request')} en attente`}>
      <Icon name="git-pull-request" size={10} />
      {count}
    </span>
  )
}

/**
 * Saisie d'un nom de catégorie : Entrée enregistre, Échap annule, quitter le
 * champ enregistre un nom modifié et annule sinon. Le champ reste ouvert si
 * l'enregistrement échoue.
 */
function NameInput({ initial, onSave, onCancel }: { initial: string; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial)
  const busyRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  async function save() {
    if (busyRef.current) return
    if (name.trim() === '' || name.trim() === initial) {
      onCancel()
      return
    }
    busyRef.current = true
    try {
      await onSave(name.trim())
    } catch (err) {
      showError(err)
      busyRef.current = false
      inputRef.current?.focus()
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      busyRef.current = true
      onCancel()
    }
  }

  return (
    <div className="side-item side-editing">
      <Icon name="folder" />
      <input
        ref={inputRef}
        className="side-input"
        value={name}
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void save()}
        aria-label="Nom de la catégorie"
        placeholder="Nom de la catégorie"
        spellCheck={false}
      />
    </div>
  )
}

/** Menu d'une catégorie : renommer, ou supprimer après un second clic de confirmation. */
function CategoryMenu({ onRename, onDelete, onClose }: { onRename: () => void; onDelete: () => void; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.parentElement?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  return (
    <div className="side-menu" role="menu" ref={rootRef}>
      <button type="button" role="menuitem" className="side-menu-item" onClick={onRename}>
        <Icon name="pencil" size={14} />
        Renommer
      </button>
      <button type="button" role="menuitem" className="side-menu-item is-danger" onClick={() => (confirming ? onDelete() : setConfirming(true))}>
        <Icon name="trash-2" size={14} />
        {confirming ? 'Confirmer' : 'Supprimer'}
      </button>
    </div>
  )
}

function SideLink({ href, icon, label, views, active }: { href: string; icon: IconName; label: string; views: RepoView[]; active: boolean }) {
  return (
    <a className={`side-item${active ? ' is-active' : ''}`} href={href} aria-current={active ? 'page' : undefined}>
      <Icon name={icon} />
      <span className="side-name">{label}</span>
      <span className="side-count">
        <PullRequestPill views={views} />
        <CountPill views={views} />
      </span>
    </a>
  )
}

/** Une catégorie de la barre : lien, et au survol le bouton de son menu. */
function CategoryItem({ category, views, active, onChanged }: { category: Category; views: RepoView[]; active: boolean; onChanged: () => void }) {
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)

  async function rename(name: string) {
    await api.renameCategory(category.id, name)
    setRenaming(false)
    onChanged()
  }

  async function remove() {
    setMenu(false)
    try {
      await api.deleteCategory(category.id)
      if (active) navigate(hrefs.home())
      onChanged()
    } catch (err) {
      showError(err)
    }
  }

  if (renaming) return <NameInput initial={category.name} onSave={rename} onCancel={() => setRenaming(false)} />

  return (
    <div className={`side-row${menu ? ' is-open' : ''}`}>
      <SideLink href={hrefs.home(category.id)} icon="folder" label={category.name} views={views} active={active} />
      <button type="button" className="side-more" aria-label={`Actions de la catégorie ${category.name}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
        <Icon name="ellipsis" size={18} />
      </button>
      {menu && (
        <CategoryMenu
          onRename={() => {
            setMenu(false)
            setRenaming(true)
          }}
          onDelete={() => void remove()}
          onClose={() => setMenu(false)}
        />
      )}
    </div>
  )
}

/** Onglet des dépôts dépréciés, avec leur nombre. */
function DeprecatedLink({ count, active }: { count: number; active: boolean }) {
  return (
    <a className={`side-item${active ? ' is-active' : ''}`} href={hrefs.deprecated()} aria-current={active ? 'page' : undefined}>
      <Icon name="archive" />
      <span className="side-name">Dépréciés</span>
      {count > 0 && <span className="pill pill-small pill-neutral">{count}</span>}
    </a>
  )
}

/**
 * Barre latérale de l'accueil : tous les dépôts, puis chaque catégorie, avec
 * le nombre de pull requests en attente et de vulnérabilités de leurs dépôts ;
 * la création se fait en place. L'onglet des dépôts dépréciés vient en dernier.
 * `views` exclut les dépôts dépréciés.
 */
export function CategorySidebar({
  categories,
  views,
  deprecatedCount,
  tab,
  onChanged,
}: {
  categories: Category[]
  views: RepoView[]
  deprecatedCount: number
  tab: HomeTab
  onChanged: () => void
}) {
  const [creating, setCreating] = useState(false)
  const selected = tab.kind === 'category' ? tab.categoryId : undefined

  async function create(name: string) {
    await api.createCategory(name)
    setCreating(false)
    onChanged()
  }

  return (
    <nav className="sidebar" aria-label="Catégories">
      <SideLink href={hrefs.home()} icon="layers" label="Tous mes projets" views={views} active={selected === null} />
      <div className="side-divider" />
      {categories.map((category) => (
        <CategoryItem
          key={category.id}
          category={category}
          views={views.filter((view) => view.repo.categoryId === category.id)}
          active={selected === category.id}
          onChanged={onChanged}
        />
      ))}
      {creating ? (
        <NameInput initial="" onSave={create} onCancel={() => setCreating(false)} />
      ) : (
        <button type="button" className="side-item side-new" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          Nouvelle catégorie
        </button>
      )}
      <div className="side-divider" />
      <DeprecatedLink count={deprecatedCount} active={tab.kind === 'deprecated'} />
    </nav>
  )
}
