import type { Repo } from '@shared/schemas/model.schema'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { usePolling } from '../hooks/usePolling'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { Icon } from './Icon'

/** Branches dont le nom contient la recherche, sans tenir compte de la casse ; toutes sans recherche. */
function filterBranches(branches: string[], query: string): string[] {
  const needle = query.trim().toLowerCase()
  return needle === '' ? branches : branches.filter((branch) => branch.toLowerCase().includes(needle))
}

/** Liste ouverte : recherche, branches du dépôt, ↑ ↓ Entrée ou clic pour choisir, Échap pour fermer. */
function BranchMenu({ repo, onClose, onChosen }: { repo: Repo; onClose: () => void; onChosen: () => void }) {
  const branches = usePolling(`branches:${repo.id}`, () => api.listBranches(repo.id), null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const matches = filterBranches(branches.data?.branches ?? [], query)
  const activeIndex = Math.min(active, matches.length - 1)

  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  async function choose(branch: string) {
    if (busy) return
    if (branch === repo.branch) {
      onClose()
      return
    }
    setBusy(true)
    try {
      await api.setBranch(repo.id, branch)
      onChosen()
      onClose()
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (activeIndex >= 0) void choose(matches[activeIndex])
      return
    }
    if (matches.length === 0 || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    const count = matches.length
    setActive((current) => (Math.min(current, count - 1) + step + count) % count)
  }

  return (
    <div className="picker-menu">
      <input
        ref={inputRef}
        className="input branch-search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        placeholder="Rechercher une branche"
        spellCheck={false}
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls="branch-options"
        aria-activedescendant={activeIndex >= 0 ? `branch-option-${activeIndex}` : undefined}
      />
      {branches.error ? (
        <p className="picker-note error-text">{branches.error}</p>
      ) : !branches.data ? (
        <p className="picker-note">Chargement des branches…</p>
      ) : matches.length === 0 ? (
        <p className="picker-note">Aucune branche ne correspond.</p>
      ) : (
        <ul className="picker-options" id="branch-options" role="listbox" ref={listRef}>
          {matches.map((branch, index) => (
            <li
              key={branch}
              id={`branch-option-${index}`}
              role="option"
              aria-selected={branch === repo.branch}
              className={`picker-option${index === activeIndex ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault()
                void choose(branch)
              }}
            >
              <span className="picker-name mono">{branch}</span>
              {branch === repo.defaultBranch && <span className="branch-default">par défaut</span>}
              {branch === repo.branch && <Icon name="check" size={14} className="picker-check" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Branche analysée du dépôt : un bouton qui ouvre la liste des branches. */
export function BranchSelector({ repo, onChanged }: { repo: Repo; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  return (
    <span className="picker" ref={rootRef}>
      <button
        type="button"
        className="picker-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Branche analysée par les corrections"
        onClick={() => setOpen(!open)}
      >
        <Icon name="git-branch" size={14} />
        <span className="mono">{repo.branch}</span>
        <Icon name="chevron-down" size={12} className="picker-chevron" />
      </button>
      {open && <BranchMenu repo={repo} onClose={() => setOpen(false)} onChosen={onChanged} />}
    </span>
  )
}
