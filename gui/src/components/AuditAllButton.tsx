import type { AuditTarget } from '@shared/schemas/api.schema'
import type { AuditScope } from '@shared/schemas/model.schema'
import { useEffect, useRef, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { showError, useNotice } from '../store/useNotice'
import { api } from '../utils/api'
import { plural } from '../utils/format'
import { Icon } from './Icon'
import { ScopeButton } from './ScopeButton'

/** Relecture de l'état de la série : rapprochée pendant les audits, espacée sinon. */
const RUNNING_POLL_MS = 1500
const IDLE_POLL_MS = 5000

/** Libellé du bouton selon les dépôts visés. */
const TARGET_LABELS: Record<AuditTarget['kind'], string> = {
  all: 'Auditer tout',
  category: 'Auditer la catégorie',
  queue: 'Auditer la file',
}

/**
 * Audite la branche par défaut des dépôts suivis de `target` (tous, une
 * catégorie ou la file d'attente), sur le périmètre choisi au lancement, avec
 * la progression sur le bouton ; à la fin d'une série suivie ici, un message
 * dit combien de dépôts ont été audités, laissés de côté ou en échec.
 */
export function AuditAllButton({ target }: { target: AuditTarget }) {
  const [pollMs, setPollMs] = useState(IDLE_POLL_MS)
  const status = usePolling('audit-all', api.getAuditAll, pollMs)
  const [starting, setStarting] = useState(false)
  const followedRef = useRef<string | null>(null)
  const state = status.data?.auditAll ?? null
  const running = state?.running ?? false

  useEffect(() => {
    setPollMs(running ? RUNNING_POLL_MS : IDLE_POLL_MS)
    if (!state) return
    if (state.running) {
      followedRef.current = state.startedAt
      return
    }
    if (followedRef.current !== state.startedAt) return
    followedRef.current = null
    const audited = state.total - state.skipped.length - state.failed.length
    const parts = [plural(audited, 'dépôt audité', 'dépôts audités')]
    if (state.skipped.length > 0) parts.push(`${state.skipped.length} laissé${state.skipped.length > 1 ? 's' : ''} de côté (opération en cours)`)
    if (state.failed.length > 0) parts.push(`${state.failed.length} en échec : ${state.failed.map((failure) => failure.repoId).join(', ')}`)
    useNotice.getState().show(state.failed.length > 0 ? 'error' : 'info', `Audit terminé : ${parts.join(', ')}.`)
  }, [state, running])

  async function start(scope: AuditScope) {
    setStarting(true)
    try {
      const { auditAll } = await api.startAuditAll(scope, target)
      followedRef.current = auditAll?.startedAt ?? null
      status.reload()
    } catch (err) {
      showError(err)
    } finally {
      setStarting(false)
    }
  }

  if (running && state) {
    return (
      <button type="button" className="button button-secondary" disabled>
        <Icon name="loader-circle" className="spin" />
        {`Audit ${state.done}/${state.total}…`}
      </button>
    )
  }
  return <ScopeButton variant="secondary" icon="scan-search" label={TARGET_LABELS[target.kind]} disabled={starting} onLaunch={(scope) => void start(scope)} />
}
