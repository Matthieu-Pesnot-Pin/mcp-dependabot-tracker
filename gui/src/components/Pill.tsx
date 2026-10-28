import type { AlertSeverity } from '@shared/schemas/model.schema'
import type { ReactNode } from 'react'

/** Pastille colorée selon une gravité. */
export function SeverityPill({ severity, children, wide }: { severity: AlertSeverity; children: ReactNode; wide?: boolean }) {
  return <span className={`pill pill-${severity}${wide ? ' pill-wide' : ''}`}>{children}</span>
}
