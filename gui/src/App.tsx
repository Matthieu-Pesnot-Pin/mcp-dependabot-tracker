import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AuditAllButton } from './components/AuditAllButton'
import { Icon } from './components/Icon'
import { NoticeToast } from './components/NoticeToast'
import { SyncButton } from './components/SyncButton'
import { TopBar } from './components/TopBar'
import { HomeScreen } from './screens/HomeScreen'
import { LoginScreen } from './screens/LoginScreen'
import { OperationScreen } from './screens/OperationScreen'
import { RepoScreen } from './screens/RepoScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { useAuth } from './store/useAuth'
import { hrefs, useRoute, type HomeTab } from './utils/router'

/** Écran de connexion sans session, interface sinon. */
export default function App() {
  const status = useAuth((state) => state.status)
  const check = useAuth((state) => state.check)
  const [checkError, setCheckError] = useState<string | null>(null)

  useEffect(() => {
    check().catch((err: unknown) => setCheckError(err instanceof Error ? err.message : String(err)))
  }, [check])

  if (checkError) {
    return (
      <div className="login">
        <p className="error-text">{checkError}</p>
      </div>
    )
  }
  if (status.kind === 'checking') return null
  if (status.kind === 'signed-out') return <LoginScreen />
  return <SignedInApp />
}

function SignedInApp() {
  const route = useRoute()
  const [adding, setAdding] = useState(false)
  const openAdd = useCallback(() => setAdding(true), [])
  const closeAdd = useCallback(() => setAdding(false), [])

  let screen: ReactNode
  const onHome = route.name === 'home' || route.name === 'queue' || route.name === 'pulls' || route.name === 'deploy' || route.name === 'deprecated'
  if (onHome) {
    const tab: HomeTab = route.name === 'home' ? { kind: 'category', categoryId: route.categoryId } : { kind: route.name }
    screen = <HomeScreen tab={tab} adding={adding} onAdd={openAdd} onCloseAdd={closeAdd} />
  } else if (route.name === 'settings') {
    screen = <SettingsScreen />
  } else if (route.name === 'repo') {
    screen = <RepoScreen key={route.repoId} repoId={route.repoId} tab={route.tab} deploymentId={route.deploymentId} />
  } else if (route.name === 'operation') {
    screen = <OperationScreen key={route.operationId} repoId={route.repoId} operationId={route.operationId} />
  } else {
    screen = (
      <div className="page">
        <p className="muted">
          Adresse inconnue : <code>{route.hash}</code>. <a className="link" href={hrefs.home()}>Revenir à l'accueil</a>.
        </p>
      </div>
    )
  }

  const action =
    onHome ? (
      <>
        <a className="button button-secondary button-icon" href={hrefs.settings()} aria-label="Réglages" title="Réglages">
          <Icon name="settings" />
        </a>
        <SyncButton />
        {route.name !== 'deploy' && route.name !== 'pulls' && (
          <AuditAllButton
            target={
              route.name === 'queue'
                ? { kind: 'queue' }
                : route.name === 'home' && route.categoryId !== null
                  ? { kind: 'category', categoryId: route.categoryId }
                  : { kind: 'all' }
            }
          />
        )}
        <button type="button" className="button button-primary" onClick={openAdd}>
          <Icon name="plus" />
          Ajouter un dépôt
        </button>
      </>
    ) : null

  return (
    <div className="app">
      <TopBar action={action} />
      <main className="main">{screen}</main>
      <NoticeToast />
    </div>
  )
}
