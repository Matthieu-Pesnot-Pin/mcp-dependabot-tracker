import type { ClaudeSession, SessionOutcome, SessionTaskRole } from '@shared/schemas/model.schema'
import { useState, type ReactNode } from 'react'
import { clockTime, dayAndTime, plural } from '../utils/format'
import { Icon, type IconName } from './Icon'

const OUTCOME_ICONS: Record<SessionOutcome, { icon: IconName; className: string }> = {
  running: { icon: 'loader-circle', className: 'text-accent spin' },
  done: { icon: 'circle-check', className: 'text-ok' },
  failed: { icon: 'circle-x', className: 'error-text' },
  cancelled: { icon: 'circle-minus', className: 'muted' },
}

const OUTCOME_TEXTS: Record<SessionOutcome, string> = {
  running: 'en cours',
  done: 'réussie',
  failed: 'échouée',
  cancelled: 'annulée',
}

const TEST_TEXTS = { passed: 'tests réussis', failed: 'tests en échec', not_run: 'tests non lancés' } as const

/** Issue affichée : une session restée « en cours » dans une opération terminée a été interrompue. */
function outcomeOf(session: ClaudeSession, active: boolean): { icon: IconName; className: string; text: string } {
  if (session.outcome === 'running' && !active) return { icon: 'circle-minus', className: 'muted', text: 'interrompue' }
  return { ...OUTCOME_ICONS[session.outcome], text: OUTCOME_TEXTS[session.outcome] }
}

function sessionTitle(session: ClaudeSession): string {
  return session.kind === 'analysis' ? 'Analyse' : `Corrections · passage ${session.run}`
}

/** Durée d'une session en minutes, jusqu'à maintenant si elle tourne encore. */
function duration(session: ClaudeSession): string {
  const minutes = Math.floor(((session.endedAt ? Date.parse(session.endedAt) : Date.now()) - Date.parse(session.startedAt)) / 60_000)
  return minutes < 1 ? "moins d'une minute" : `${minutes} min`
}

/** Ce que la session a fait de la tâche : `lue · 2 remarques`, `sous-tâche · créée`. */
function roleText(session: ClaudeSession, role: SessionTaskRole): string {
  if (role === 'read') return `lue · ${plural(session.remarks.length, 'remarque')}`
  const done = role === 'created' ? 'créée' : 'mise à jour'
  return session.kind === 'repair' ? `sous-tâche · ${done}` : done
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="session-section">
      <p className="session-section-title">{title}</p>
      {children}
    </section>
  )
}

/** Résultat d'une session : son rapport, ou la raison de son échec. */
function SessionResult({ session, active }: { session: ClaudeSession; active: boolean }) {
  if (session.outcome === 'failed') return <p className="error-text pre">{session.error}</p>
  if (session.outcome === 'cancelled') return <p className="muted">Session annulée avec l'opération.</p>
  if (session.outcome === 'running') return <p className="muted">{active ? 'Le résultat arrive à la fin de la session.' : "Session interrompue avant d'avoir rendu son résultat."}</p>
  if (session.analysisReport) {
    const { summary, force } = session.analysisReport
    return (
      <>
        <p className="session-text">{summary}</p>
        <p className="session-line">
          <Icon name="sparkles" size={12} className="text-accent" />
          {force.recommended ? '--force recommandé' : '--force déconseillé'} — {force.reason}
        </p>
      </>
    )
  }
  if (!session.repairReport) return null
  const { summary, changes, tests } = session.repairReport
  const remaining = session.remaining
  const facts = [
    session.commit ? `commit ${session.commit.slice(0, 7)}` : 'aucun commit',
    changes.length > 0 ? plural(changes.length, 'fichier') : 'aucun fichier modifié',
    TEST_TEXTS[tests.outcome],
    remaining === null ? null : remaining === 0 ? 'aucune vulnérabilité restante' : plural(remaining, 'vulnérabilité restante', 'vulnérabilités restantes'),
  ].filter(Boolean)
  return (
    <>
      <p className="session-text">{summary}</p>
      {changes.length > 0 && (
        <ul className="repair-changes">
          {changes.map((change) => (
            <li key={change.file}>
              <span className="mono">{change.file}</span>
              <span className="muted">{change.change}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="session-line">
        <Icon name={remaining === 0 && tests.outcome !== 'failed' ? 'circle-check' : 'circle-alert'} size={12} className={remaining === 0 && tests.outcome !== 'failed' ? 'text-ok' : 'text-warning'} />
        {facts.join(' · ')}
      </p>
    </>
  )
}

/** Détail d'une session : tâches organizer, remarques au lancement, déroulé et résultat. */
function SessionDetail({ session, active }: { session: ClaudeSession; active: boolean }) {
  const status = outcomeOf(session, active)
  const end = session.endedAt ? ` à ${clockTime(session.endedAt).slice(0, 5)}` : ''
  return (
    <div className="panel session-detail">
      <h2 className="session-title">{session.kind === 'analysis' ? 'Analyse par Claude' : `Corrections par Claude — passage ${session.run}`}</h2>
      <p className="subtitle">
        {dayAndTime(session.startedAt)}
        {end} · {plural(session.turns, 'tour')} · {status.text}
      </p>

      {session.tasks.length > 0 && (
        <Section title="Tâches organizer">
          <ul className="session-tasks">
            {session.tasks.map(({ task, role }) => (
              <li key={`${task.key}-${role}`}>
                <a className="link mono" href={task.url} target="_blank" rel="noreferrer">
                  {task.key}
                </a>
                <span className="session-task-title">{task.title}</span>
                <span className="session-task-role">{roleText(session, role)}</span>
                <a className="icon-link" href={task.url} target="_blank" rel="noreferrer" aria-label={`Ouvrir ${task.key}`}>
                  <Icon name="external-link" size={14} />
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {session.kind === 'repair' && (
        <Section title="Remarques au lancement">
          {session.remarks.length === 0 ? (
            <p className="muted">Aucune remarque : Claude a suivi son analyse.</p>
          ) : (
            <ul className="session-remarks">
              {session.remarks.map((remark, index) => (
                <li key={`${remark.createdAt}-${index}`}>{remark.body}</li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title="Messages et actions de Claude">
        {session.events.length === 0 ? (
          <p className="muted">Aucune action enregistrée.</p>
        ) : (
          <div className="session-events">
            {session.events.map((event, index) =>
              event.kind === 'text' ? (
                <p key={index} className="session-message">
                  {event.text}
                </p>
              ) : (
                <p key={index} className="session-tool mono">
                  {event.text}
                </p>
              )
            )}
          </div>
        )}
      </Section>

      <Section title="Résultat">
        <SessionResult session={session} active={active} />
      </Section>
    </div>
  )
}

/** Sessions de Claude d'une opération : la liste à gauche, la session choisie à droite, la plus récente par défaut. */
export function ClaudeSessions({ sessions, active }: { sessions: ClaudeSession[]; active: boolean }) {
  const [selected, setSelected] = useState<number | null>(null)
  const index = selected ?? sessions.length - 1
  const session = sessions[index]

  return (
    <div className="sessions">
      <div className="session-list">
        {sessions.map((candidate, position) => {
          const status = outcomeOf(candidate, active)
          return (
            <button key={`${candidate.kind}-${candidate.run}`} type="button" className={`session-card${position === index ? ' is-active' : ''}`} onClick={() => setSelected(position)}>
              <span className="session-card-title">
                <Icon name={status.icon} size={14} className={status.className} />
                {sessionTitle(candidate)}
              </span>
              <span className="session-card-meta">
                {clockTime(candidate.startedAt).slice(0, 5)} · {duration(candidate)} · {plural(candidate.turns, 'tour')}
              </span>
            </button>
          )
        })}
      </div>
      {session && <SessionDetail session={session} active={active} />}
    </div>
  )
}
