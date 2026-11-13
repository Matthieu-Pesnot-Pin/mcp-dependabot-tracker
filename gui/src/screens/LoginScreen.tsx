import { useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { useAuth } from '../store/useAuth'

/** Écran de connexion : e-mail, mot de passe, un seul bouton. */
export function LoginScreen() {
  const signIn = useAuth((state) => state.signIn)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await signIn(email.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPassword('')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark">
            <Icon name="shield-check" />
          </span>
          Dependabot Tracker
        </div>
        <label className="login-field">
          <span className="field-label">E-mail</span>
          <input className="input" type="email" autoComplete="username" autoFocus required value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="login-field">
          <span className="field-label">Mot de passe</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error && (
          <p className="login-error" role="alert">
            <Icon name="circle-alert" />
            {error}
          </p>
        )}
        <button type="submit" className="button button-primary login-submit" disabled={pending}>
          Se connecter
        </button>
      </form>
    </div>
  )
}
