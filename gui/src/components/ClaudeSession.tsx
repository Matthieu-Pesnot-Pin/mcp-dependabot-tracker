import type { Operation, Repair } from '@shared/schemas/model.schema'
import type { ReactNode } from 'react'
import { clockTime, dayAndTime, plural } from '../utils/format'
import { Icon } from './Icon'

const TEST_TEXTS = { passed: 'tests réussis', failed: 'tests en échec', not_run: 'tests non lancés' } as const

/** État de la session : en cours, réussie, échouée, ou interrompue avec l'opération. */
function statusText(repair: Repair, active: boolean): string {
  if (repair.error) return 'échouée'
  if (repair.report) return 'réussie'
  return active ? 'en cours' : 'interrompue'
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="session-section">
      <p className="session-section-title">{title}</p>
      {children}
    </section>
  )
}

/** Résultat de la session : son rapport, ou la raison de son échec. */
function SessionResult({ repair, remaining, active }: { repair: Repair; remaining: number | null; active: boolean }) {
  if (repair.error) return <p className="error-text pre">{repair.error}</p>
  if (!repair.report) return <p className="muted">{active ? 'Le résultat arrive à la fin de la session.' : "Session interrompue avant d'avoir rendu son résultat."}</p>
  const { summary, changes, tests } = repair.report
  const facts = [
    repair.commit ? `commit ${repair.commit.slice(0, 7)}` : 'aucun commit',
    changes.length > 0 ? plural(changes.length, 'fichier') : 'aucun fichier modifié',
    TEST_TEXTS[tests.outcome],
    remaining === null ? null : remaining === 0 ? 'aucune vulnérabilité restante' : plural(remaining, 'vulnérabilité restante', 'vulnérabilités restantes'),
  ].filter(Boolean)
  const clean = remaining === 0 && tests.outcome !== 'failed'
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
        <Icon name={clean ? 'circle-check' : 'circle-alert'} size={12} className={clean ? 'text-ok' : 'text-warning'} />
        {facts.join(' · ')}
      </p>
    </>
  )
}

/** Session de corrections par Claude d'une opération : sa tâche de rapport, son déroulé et son résultat. */
export function ClaudeSession({ operation, repair, active }: { operation: Operation; repair: Repair; active: boolean }) {
  const end = repair.endedAt ? ` à ${clockTime(repair.endedAt).slice(0, 5)}` : ''
  return (
    <div className="panel session-detail">
      <h2 className="session-title">Corrections par Claude</h2>
      <p className="subtitle">
        {dayAndTime(repair.startedAt)}
        {end} · {plural(repair.turns, 'tour')} · {statusText(repair, active)}
      </p>

      {repair.task && (
        <Section title="Rapport dans l'organizer">
          <ul className="session-tasks">
            <li>
              <a className="link mono" href={repair.task.url} target="_blank" rel="noreferrer">
                {repair.task.key}
              </a>
              <span className="session-task-title">{repair.task.title}</span>
              <a className="icon-link" href={repair.task.url} target="_blank" rel="noreferrer" aria-label={`Ouvrir ${repair.task.key}`}>
                <Icon name="external-link" size={14} />
              </a>
            </li>
          </ul>
        </Section>
      )}

      <Section title="Messages et actions de Claude">
        {repair.events.length === 0 ? (
          <p className="muted">Aucune action enregistrée.</p>
        ) : (
          <div className="session-events">
            {repair.events.map((event, index) =>
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
        <SessionResult repair={repair} remaining={operation.counts.afterRepair} active={active} />
      </Section>
    </div>
  )
}
