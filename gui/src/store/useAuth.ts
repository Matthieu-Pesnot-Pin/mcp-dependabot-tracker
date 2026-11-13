import { create } from 'zustand'

export interface AuthUser {
  email: string
  name: string
}

type AuthStatus = { kind: 'checking' } | { kind: 'signed-out' } | { kind: 'signed-in'; user: AuthUser }

interface AuthState {
  status: AuthStatus
  /** Lit la session ouverte auprès du serveur. */
  check: () => Promise<void>
  /** Ouvre une session ; lève une erreur au message lisible si elle est refusée. */
  signIn: (email: string, password: string) => Promise<void>
  /** Ferme la session. */
  signOut: () => Promise<void>
  /** La session a expiré : retour à l'écran de connexion. */
  expire: () => void
}

/** Message d'une réponse d'erreur de Better Auth, selon son code HTTP. */
async function signInError(response: Response): Promise<string> {
  if (response.status === 401) return 'E-mail ou mot de passe incorrect.'
  if (response.status === 429) return 'Trop de tentatives : réessayez dans une minute.'
  try {
    const body = await response.json()
    if (body?.message) return body.message
  } catch {
    // Réponse non-JSON : le code HTTP reste le message disponible.
  }
  return `Connexion impossible (HTTP ${response.status}).`
}

function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

/** Session de l'utilisateur de l'interface. */
export const useAuth = create<AuthState>((set) => ({
  status: { kind: 'checking' },
  check: async () => {
    const response = await fetch('api/auth/get-session')
    if (!response.ok) throw new Error(`Session illisible (HTTP ${response.status}).`)
    const body = (await response.json()) as { user: AuthUser } | null
    set({ status: body ? { kind: 'signed-in', user: { email: body.user.email, name: body.user.name } } : { kind: 'signed-out' } })
  },
  signIn: async (email, password) => {
    const response = await postJson('api/auth/sign-in/email', { email, password })
    if (!response.ok) throw new Error(await signInError(response))
    const body = (await response.json()) as { user: AuthUser }
    set({ status: { kind: 'signed-in', user: { email: body.user.email, name: body.user.name } } })
  },
  signOut: async () => {
    await postJson('api/auth/sign-out', {})
    set({ status: { kind: 'signed-out' } })
  },
  expire: () => set({ status: { kind: 'signed-out' } }),
}))
