import type { ReactNode } from 'react'
import { useAuth } from '../store/useAuth'
import { useNotice } from '../store/useNotice'
import { hrefs } from '../utils/router'
import { Icon } from './Icon'

/** Barre supérieure : marque (lien vers l'accueil), déconnexion et action contextuelle. */
export function TopBar({ action }: { action?: ReactNode }) {
  const status = useAuth((state) => state.status)
  const signOut = useAuth((state) => state.signOut)
  const showNotice = useNotice((state) => state.show)
  const email = status.kind === 'signed-in' ? status.user.email : ''

  const logout = () => {
    signOut().catch((err: unknown) => showNotice('error', `Déconnexion impossible : ${err instanceof Error ? err.message : String(err)}`))
  }

  return (
    <header className="topbar">
      <a className="brand" href={hrefs.home()}>
        <span className="brand-mark">
          <Icon name="shield-check" />
        </span>
        Dependabot Tracker
      </a>
      <div className="spacer" />
      <button type="button" className="button button-secondary button-icon" onClick={logout} aria-label="Se déconnecter" title={`Se déconnecter\n${email}`}>
        <Icon name="log-out" />
      </button>
      {action}
    </header>
  )
}
