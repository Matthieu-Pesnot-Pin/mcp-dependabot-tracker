import { useCallback, useEffect, useRef, useState } from 'react'

export interface Polled<T> {
  data: T | null
  error: string | null
  /** Relance une lecture tout de suite, par exemple après une action. */
  reload: () => void
}

/** Dernière réponse reçue pour chaque clé, affichée dès qu'un écran de même clé se monte. */
const lastData = new Map<string, unknown>()

/**
 * Lit `fetcher` tout de suite, puis `intervalMs` après la fin de chaque lecture,
 * sans requêtes simultanées. En attendant la première lecture, renvoie la
 * dernière réponse reçue pour la même `key`. `intervalMs` à null arrête les
 * relectures. `remember` à false écarte la dernière réponse : la première
 * lecture part de null, pour un formulaire initialisé une seule fois.
 */
export function usePolling<T>(key: string, fetcher: () => Promise<T>, intervalMs: number | null, { remember = true }: { remember?: boolean } = {}): Polled<T> {
  const cached = (key: string): T | null => (remember && lastData.has(key) ? (lastData.get(key) as T) : null)
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>(() => ({ key, data: cached(key), error: null }))
  const fetcherRef = useRef(fetcher)
  const intervalRef = useRef(intervalMs)
  const wakeRef = useRef<() => void>(() => {})

  useEffect(() => {
    fetcherRef.current = fetcher
    intervalRef.current = intervalMs
  })

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false

    async function poll() {
      if (running) return
      running = true
      clearTimeout(timer)
      try {
        const data = await fetcherRef.current()
        lastData.set(key, data)
        if (!stopped) setState({ key, data, error: null })
      } catch (err) {
        if (!stopped) setState((previous) => ({ key, data: previous.key === key ? previous.data : cached(key), error: (err as Error).message }))
      }
      running = false
      if (!stopped && intervalRef.current !== null) timer = setTimeout(poll, intervalRef.current)
    }

    wakeRef.current = () => void poll()
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [key])

  const reload = useCallback(() => wakeRef.current(), [])
  const current = state.key === key ? state : { data: cached(key), error: null }
  return { data: current.data, error: current.error, reload }
}
