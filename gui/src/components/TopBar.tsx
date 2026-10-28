import type { ReactNode } from 'react'
import { hrefs } from '../utils/router'
import { Icon } from './Icon'

/** Barre supérieure : marque (lien vers l'accueil) et action contextuelle. */
export function TopBar({ action }: { action?: ReactNode }) {
  return (
    <header className="topbar">
      <a className="brand" href={hrefs.home()}>
        <span className="brand-mark">
          <Icon name="shield-check" />
        </span>
        Dependabot Tracker
      </a>
      <div className="spacer" />
      {action}
    </header>
  )
}
