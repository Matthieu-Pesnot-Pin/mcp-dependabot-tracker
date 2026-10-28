import { useState } from 'react'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { Icon } from './Icon'

/** Relit tout de suite les données GitHub de tous les dépôts ; l'accueil les affiche à sa lecture suivante. */
export function SyncButton() {
  const [busy, setBusy] = useState(false)

  async function sync() {
    setBusy(true)
    try {
      await api.syncRepos()
    } catch (err) {
      showError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button type="button" className="button button-secondary" onClick={() => void sync()} disabled={busy}>
      <Icon name="refresh-cw" className={busy ? 'spin' : undefined} />
      Synchroniser maintenant
    </button>
  )
}
