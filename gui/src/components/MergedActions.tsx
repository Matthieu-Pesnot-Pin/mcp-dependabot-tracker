import { useState } from 'react'
import { showError } from '../store/useNotice'
import { api } from '../utils/api'
import { Icon } from './Icon'

/**
 * Boutons d'un dépôt dont une pull request du tracker attend : « Mergée » la
 * retire de « PR en attente » quand le déploiement est automatique ; « Mergée,
 * à déployer » marque aussi le dépôt « à déployer ».
 */
export function MergedActions({ repoId, onDone, compact = false }: { repoId: string; onDone: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false)

  async function merged(deploy: boolean) {
    setBusy(true)
    try {
      await api.markMerged(repoId, deploy)
      onDone()
    } catch (err) {
      showError(err)
      setBusy(false)
    }
  }

  const size = compact ? ' row-button' : ''
  return (
    <>
      <button
        type="button"
        className={`button button-secondary${size}`}
        onClick={() => void merged(false)}
        disabled={busy}
        title="PR fusionnée, déploiement automatique : le dépôt quitte « PR en attente »"
      >
        <Icon name="git-merge" size={14} />
        Mergée
      </button>
      <button
        type="button"
        className={`button button-secondary${size}`}
        onClick={() => void merged(true)}
        disabled={busy}
        title="PR fusionnée, déploiement à faire : le dépôt passe dans « À déployer »"
      >
        <Icon name="rocket" size={14} />
        Mergée, à déployer
      </button>
    </>
  )
}
