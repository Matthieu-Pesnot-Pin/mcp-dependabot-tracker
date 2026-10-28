import type { Repo } from '@shared/schemas/model.schema'
import { useEffect, useRef, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { Icon } from './Icon'

/** Liste ouverte : « Sans catégorie » puis les catégories ; un clic range le dépôt, Échap ferme. */
function CategoryMenu({ repo, onClose, onChosen }: { repo: Repo; onClose: () => void; onChosen: () => void }) {
  const categories = usePolling('categories', api.listCategories, null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function choose(categoryId: string | null) {
    if (busy) return
    if (categoryId === repo.categoryId) {
      onClose()
      return
    }
    setBusy(true)
    try {
      await api.setCategory(repo.id, categoryId)
      onChosen()
      onClose()
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  const options = [{ id: null, name: 'Sans catégorie' }, ...(categories.data?.categories ?? [])]

  return (
    <div className="picker-menu picker-menu-narrow">
      {categories.error ? (
        <p className="picker-note error-text">{categories.error}</p>
      ) : !categories.data ? (
        <p className="picker-note">Chargement des catégories…</p>
      ) : (
        <ul className="picker-options" role="listbox" aria-label="Catégorie">
          {options.map((option) => (
            <li
              key={option.id ?? ''}
              role="option"
              aria-selected={option.id === repo.categoryId}
              className="picker-option"
              onMouseDown={(event) => {
                event.preventDefault()
                void choose(option.id)
              }}
            >
              <span className="picker-name">{option.name}</span>
              {option.id === repo.categoryId && <Icon name="check" size={14} className="picker-check" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Catégorie du dépôt : un bouton qui ouvre la liste des catégories. */
export function CategorySelector({ repo, categoryName, onChanged }: { repo: Repo; categoryName: string | null; onChanged: () => void }) {
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
      <button type="button" className="picker-chip" aria-haspopup="listbox" aria-expanded={open} title="Catégorie du dépôt" onClick={() => setOpen(!open)}>
        <Icon name="folder" size={14} />
        <span>{categoryName ?? 'Sans catégorie'}</span>
        <Icon name="chevron-down" size={12} className="picker-chevron" />
      </button>
      {open && <CategoryMenu repo={repo} onClose={() => setOpen(false)} onChosen={onChanged} />}
    </span>
  )
}
