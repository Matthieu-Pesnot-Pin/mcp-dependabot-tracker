import { create } from 'zustand'

export interface AuthUser {
  email: string
  name: string
}

type AuthStatus = { kind: 'checking' } | { kind: 'signed-out' } | { kind: 'signed-in'; user: AuthUser }

/** Suite d'une connexion par mot de passe : session ouverte, ou code de vérification attendu. */
export type SignInStep = 'signed-in' | 'two-factor'

/** Refus d'un code de vérification ; `restart` dit que la connexion doit reprendre au mot de passe. */
export class TwoFactorError extends Error {
  readonly restart: boolean

  constructor(message: string, restart: boolean) {
    super(message)
    this.name = 'TwoFactorError'
    this.restart = restart
  }
}

interface AuthState {
  status: AuthStatus
  /** Lit la session ouverte auprès du serveur. */
  check: () => Promise<void>
  /**
   * Vérifie l'e-mail et le mot de passe ; lève une erreur au message lisible
   * s'ils sont refusés. Rend `two-factor` quand le compte attend encore son
   * code de vérification : la session ne s'ouvre qu'avec `verifyTwoFactor`.
   */
  signIn: (email: string, password: string) => Promise<SignInStep>
  /**
   * Ouvre la session avec le code de l'application d'authentification (six
   * chiffres) ou un code de secours ; lève `TwoFactorError` s'il est refusé.
   */
  verifyTwoFactor: (code: string) => Promise<void>
  /** Ferme la session. */
  signOut: () => Promise<void>
  /** La session a expiré : retour à l'écran de connexion. */
  expire: () => void
}

/** Corps JSON d'une réponse de Better Auth, ou null. */
async function readBody(response: Response): Promise<{ code?: string; message?: string } | null> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** Message d'une réponse d'erreur de Better Auth, selon son code HTTP. */
async function signInError(response: Response): Promise<string> {
  if (response.status === 401) return 'E-mail ou mot de passe incorrect.'
  if (response.status === 429) return 'Trop de tentatives : réessayez dans une minute.'
  const body = await readBody(response)
  return body?.message ?? `Connexion impossible (HTTP ${response.status}).`
}

/** Refus d'un code de vérification, selon le code d'erreur de Better Auth. */
async function twoFactorError(response: Response): Promise<TwoFactorError> {
  const body = await readBody(response)
  if (body?.code === 'INVALID_CODE' || body?.code === 'INVALID_BACKUP_CODE') return new TwoFactorError('Code incorrect.', false)
  if (body?.code === 'ACCOUNT_TEMPORARILY_LOCKED') return new TwoFactorError('Trop de codes incorrects : le compte est verrouillé quelques minutes.', true)
  if (body?.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE') return new TwoFactorError('Trop de codes incorrects : reconnectez-vous.', true)
  if (body?.code === 'INVALID_TWO_FACTOR_COOKIE') return new TwoFactorError('La vérification a expiré : reconnectez-vous.', true)
  if (response.status === 429) return new TwoFactorError('Trop de tentatives : réessayez dans quelques secondes.', false)
  return new TwoFactorError(body?.message ?? `Vérification impossible (HTTP ${response.status}).`, false)
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
    const body = (await response.json()) as { user: AuthUser } | { twoFactorRedirect: true }
    if ('twoFactorRedirect' in body) return 'two-factor'
    set({ status: { kind: 'signed-in', user: { email: body.user.email, name: body.user.name } } })
    return 'signed-in'
  },
  verifyTwoFactor: async (input) => {
    const code = input.trim()
    const digits = code.replace(/\s+/g, '')
    const response = /^\d{6}$/.test(digits)
      ? await postJson('api/auth/two-factor/verify-totp', { code: digits })
      : await postJson('api/auth/two-factor/verify-backup-code', { code })
    if (!response.ok) throw await twoFactorError(response)
    const body = (await response.json()) as { user: AuthUser }
    set({ status: { kind: 'signed-in', user: { email: body.user.email, name: body.user.name } } })
  },
  signOut: async () => {
    await postJson('api/auth/sign-out', {})
    set({ status: { kind: 'signed-out' } })
  },
  expire: () => set({ status: { kind: 'signed-out' } }),
}))
