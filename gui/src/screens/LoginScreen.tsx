import { useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { TwoFactorError, useAuth } from '../store/useAuth'

/**
 * Écran de connexion : e-mail et mot de passe, puis, pour un compte à double
 * authentification, le code de l'application d'authentification ou un code de
 * secours. Un seul bouton par étape.
 */
export function LoginScreen() {
  const signIn = useAuth((state) => state.signIn)
  const verifyTwoFactor = useAuth((state) => state.verifyTwoFactor)
  const [step, setStep] = useState<'password' | 'code'>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      if ((await signIn(email.trim(), password)) === 'two-factor') setStep('code')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPassword('')
      setPending(false)
    }
  }

  const submitCode = async (event: FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await verifyTwoFactor(code)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setCode('')
      if (err instanceof TwoFactorError && err.restart) setStep('password')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={step === 'password' ? submitPassword : submitCode}>
        <div className="login-brand">
          <span className="brand-mark">
            <Icon name="shield-check" />
          </span>
          Dependabot Tracker
        </div>
        {step === 'password' ? (
          <>
            <label className="login-field">
              <span className="field-label">E-mail</span>
              <input className="input" type="email" autoComplete="username" autoFocus required value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label className="login-field">
              <span className="field-label">Mot de passe</span>
              <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
          </>
        ) : (
          <label className="login-field">
            <span className="field-label">Code de vérification</span>
            <input
              key="code"
              className="input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <span className="login-hint">Code à six chiffres de votre application d'authentification, ou un code de secours.</span>
          </label>
        )}
        {error && (
          <p className="login-error" role="alert">
            <Icon name="circle-alert" />
            {error}
          </p>
        )}
        <button type="submit" className="button button-primary login-submit" disabled={pending}>
          {step === 'password' ? 'Se connecter' : 'Vérifier'}
        </button>
      </form>
    </div>
  )
}
