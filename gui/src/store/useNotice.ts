import { create } from 'zustand'

export interface Notice {
  id: number
  kind: 'info' | 'error'
  text: string
}

interface NoticeState {
  notice: Notice | null
  show: (kind: Notice['kind'], text: string) => void
  dismiss: () => void
}

/** Durée d'affichage d'un message, avant qu'il ne disparaisse de lui-même. */
const NOTICE_MS = 6000

let nextId = 1
let timer: ReturnType<typeof setTimeout> | undefined

/** Message bref affiché en bas à droite : confirmation ou erreur d'une action. */
export const useNotice = create<NoticeState>((set) => ({
  notice: null,
  show: (kind, text) => {
    clearTimeout(timer)
    set({ notice: { id: nextId++, kind, text } })
    timer = setTimeout(() => set({ notice: null }), NOTICE_MS)
  },
  dismiss: () => {
    clearTimeout(timer)
    set({ notice: null })
  },
}))

export function showError(err: unknown) {
  useNotice.getState().show('error', err instanceof Error ? err.message : String(err))
}
