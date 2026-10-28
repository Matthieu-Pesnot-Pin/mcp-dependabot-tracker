import type { AlertSeverity } from '@shared/schemas/model.schema'
import type { ReactNode } from 'react'

/** Pastille colorée selon une gravité ; `wide` à largeur fixe, `small` pour un simple compte, `faded` estompée. */
export function SeverityPill({ severity, children, wide, small, faded }: { severity: AlertSeverity; children: ReactNode; wide?: boolean; small?: boolean; faded?: boolean }) {
  return <span className={`pill pill-${severity}${wide ? ' pill-wide' : ''}${small ? ' pill-small' : ''}${faded ? ' pill-faded' : ''}`}>{children}</span>
}
