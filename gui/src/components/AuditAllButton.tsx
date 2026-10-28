import { useEffect, useRef, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { showError, useNotice } from '../store/useNotice'
import { api } from '../utils/api'
import { plural } from '../utils/format'
import { Icon } from './Icon'

/** Relecture de l'état de la série : rapprochée pendant les audits, espacée sinon. */
const RUNNING_POLL_MS = 1500
const IDLE_POLL_MS = 5000

/**
 * Audite la branche par défaut de tous les dépôts suivis, avec la progression
 * sur le bouton ; à la fin d'une série suivie ici, un message dit combien de
 * dépôts ont été audités, laissés de côté ou en échec.
 */
export function AuditAllButton() {
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

  async function start() {
    setStarting(true)
    try {
      const { auditAll } = await api.startAuditAll()
      followedRef.current = auditAll?.startedAt ?? null
      status.reload()
    } catch (err) {
      showError(err)
    } finally {
      setStarting(false)
    }
  }

  return (
    <button type="button" className="button button-secondary" onClick={() => void start()} disabled={running || starting}>
      <Icon name={running ? 'loader-circle' : 'scan-search'} className={running ? 'spin' : undefined} />
      {running && state ? `Audit ${state.done}/${state.total}…` : 'Auditer tout'}
    </button>
  )
}
