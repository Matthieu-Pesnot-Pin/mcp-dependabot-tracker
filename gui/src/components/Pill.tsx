import type { AlertSeverity } from '@shared/schemas/model.schema'
import type { ReactNode } from 'react'

/** Pastille colorée selon une gravité ; `wide` à largeur fixe, `small` pour un simple compte. */
export function SeverityPill({ severity, children, wide, small }: { severity: AlertSeverity; children: ReactNode; wide?: boolean; small?: boolean }) {
  return <span className={`pill pill-${severity}${wide ? ' pill-wide' : ''}${small ? ' pill-small' : ''}`}>{children}</span>
}
