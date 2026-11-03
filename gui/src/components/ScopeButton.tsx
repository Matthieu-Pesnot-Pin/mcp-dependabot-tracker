import { DEFAULT_AUDIT_SCOPE, type AuditScope } from '@shared/schemas/model.schema'
import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'

const SCOPE_OPTIONS: { scope: AuditScope; label: string; detail: string }[] = [
  { scope: 'production', label: 'Production', detail: 'devDependencies laissées de côté' },
  { scope: 'all', label: 'Toutes les dépendances', detail: 'devDependencies comprises' },
]

/**
 * Bouton qui lance une action sur un périmètre d'audit : le clic principal la
 * lance sur le périmètre par défaut, la flèche ouvre le choix du périmètre ;
 * Échap ou un clic ailleurs ferme le menu.
 */
export function ScopeButton({
  variant,
  icon,
  label,
  disabled = false,
  onLaunch,
}: {
  variant: 'primary' | 'secondary'
  icon: IconName
  label: string
  disabled?: boolean
  onLaunch: (scope: AuditScope) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function launch(scope: AuditScope) {
    setOpen(false)
    onLaunch(scope)
  }

  return (
    <span className="picker split-button" ref={rootRef}>
      <button type="button" className={`button button-${variant} split-main`} onClick={() => launch(DEFAULT_AUDIT_SCOPE)} disabled={disabled}>
        <Icon name={icon} />
        {label}
      </button>
      <button
        type="button"
        className={`button button-${variant} split-toggle`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choisir le périmètre"
        title="Choisir le périmètre"
        onClick={() => setOpen(!open)}
        disabled={disabled}
      >
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="picker-menu scope-menu" role="menu">
          {SCOPE_OPTIONS.map((option) => (
            <button key={option.scope} type="button" role="menuitem" className="scope-option" onClick={() => launch(option.scope)}>
              <span className="scope-option-text">
                <span className="scope-option-label">{option.label}</span>
                <span className="scope-option-detail">{option.detail}</span>
              </span>
              {option.scope === DEFAULT_AUDIT_SCOPE && <Icon name="check" size={14} className="picker-check" />}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
