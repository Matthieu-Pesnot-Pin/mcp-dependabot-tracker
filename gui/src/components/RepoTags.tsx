import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useDismiss } from '../hooks/useDismiss'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { MAX_TAG_LENGTH, sameTag, type TagCount } from '../utils/tags'
import { Icon } from './Icon'

/**
 * Menu des tags d'un dépôt : le champ filtre les tags connus, une case coche ou
 * décoche chacun, et un nom inconnu se crée par « Créer ». ↑ et ↓ parcourent,
 * Entrée applique l'option en surbrillance ; chaque changement s'enregistre aussitôt.
 */
function TagMenu({ tags, known, onToggle }: { tags: string[]; known: TagCount[]; onToggle: (name: string) => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const trimmed = query.trim()
  const matches = known.filter((tag) => tag.name.toLowerCase().includes(trimmed.toLowerCase()))
  const canCreate = trimmed !== '' && !known.some((tag) => sameTag(tag.name, trimmed))
  const options = [...matches.map((tag) => tag.name), ...(canCreate ? [trimmed] : [])]
  const activeIndex = Math.min(active, options.length - 1)

  function apply(name: string) {
    onToggle(name)
    if (canCreate && name === trimmed) setQuery('')
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (activeIndex >= 0) apply(options[activeIndex])
      return
    }
    if (options.length === 0 || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    setActive((current) => (Math.min(current, options.length - 1) + step + options.length) % options.length)
  }

  return (
    <div className="tag-menu" role="dialog" aria-label="Tags du dépôt">
      <label className="tag-search">
        <Icon name="tag" size={14} />
        <input
          ref={inputRef}
          value={query}
          maxLength={MAX_TAG_LENGTH}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Rechercher ou créer un tag"
          spellCheck={false}
          aria-label="Rechercher ou créer un tag"
        />
      </label>
      {options.length > 0 && (
        <ul className="tag-options" role="listbox" aria-multiselectable="true">
          {matches.map((tag, index) => {
            const checked = tags.some((own) => sameTag(own, tag.name))
            return (
              <li
                key={tag.name}
                role="option"
                aria-selected={checked}
                className={`tag-option${index === activeIndex ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  apply(tag.name)
                }}
              >
                <span className={`tag-box${checked ? ' is-checked' : ''}`}>{checked && <Icon name="check" size={12} />}</span>
                <span className="picker-name">{tag.name}</span>
                <span className="tag-option-count">{tag.count}</span>
              </li>
            )
          })}
          {canCreate && (
            <li
              role="option"
              aria-selected={false}
              className={`tag-option${activeIndex === matches.length ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(matches.length)}
              onMouseDown={(event) => {
                event.preventDefault()
                apply(trimmed)
              }}
            >
              <Icon name="plus" size={14} className="tag-create-icon" />
              <span className="picker-name">Créer « {trimmed} »</span>
            </li>
          )}
        </ul>
      )}
      {options.length === 0 && <p className="picker-note">Saisissez un nom pour créer un tag.</p>}
    </div>
  )
}

/**
 * Tags d'un dépôt sur sa ligne : une pastille par tag, celle de `current` mise
 * en avant, puis le bouton « + » qui ouvre le menu des tags. Le bouton
 * n'apparaît qu'au survol de la ligne, ou en permanence sur un écran tactile.
 */
export function RepoTags({ repoId, tags, known, current, onChanged }: { repoId: string; tags: string[]; known: TagCount[]; current: string | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<{ base: string; tags: string[] } | null>(null)
  const close = useCallback(() => setOpen(false), [])
  const ref = useDismiss(open, close)
  const base = JSON.stringify(tags)
  const saved = pending !== null && pending.base === base ? pending.tags : tags

  async function toggle(name: string) {
    const next = saved.some((own) => sameTag(own, name)) ? saved.filter((own) => !sameTag(own, name)) : [...saved, name]
    setPending({ base, tags: next })
    try {
      await api.setTags(repoId, next)
      onChanged()
    } catch (err) {
      setPending(null)
      showError(err)
    }
  }

  return (
    <div className={`repo-tags${open ? ' is-open' : ''}`} ref={ref}>
      {saved.map((tag) => (
        <span key={tag} className={`tag-pill${current !== null && sameTag(tag, current) ? ' is-current' : ''}`}>
          {tag}
        </span>
      ))}
      <button
        type="button"
        className="tag-add"
        onClick={() => setOpen(!open)}
        title="Tags du dépôt"
        aria-label={`Tags de ${repoId}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="plus" size={12} />
      </button>
      {open && <TagMenu tags={saved} known={known} onToggle={(name) => void toggle(name)} />}
    </div>
  )
}
