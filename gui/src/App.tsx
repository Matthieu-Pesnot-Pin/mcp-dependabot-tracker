import { useCallback, useState, type ReactNode } from 'react'
import { Icon } from './components/Icon'
import { NoticeToast } from './components/NoticeToast'
import { SyncButton } from './components/SyncButton'
import { TopBar } from './components/TopBar'
import { HomeScreen } from './screens/HomeScreen'
import { OperationScreen } from './screens/OperationScreen'
import { RepoScreen } from './screens/RepoScreen'
import { hrefs, useRoute } from './utils/router'

export default function App() {
  const route = useRoute()
  const [adding, setAdding] = useState(false)
  const openAdd = useCallback(() => setAdding(true), [])
  const closeAdd = useCallback(() => setAdding(false), [])

  let screen: ReactNode
  if (route.name === 'home') {
    screen = <HomeScreen categoryId={route.categoryId} adding={adding} onAdd={openAdd} onCloseAdd={closeAdd} />
  } else if (route.name === 'repo') {
    screen = <RepoScreen key={route.repoId} repoId={route.repoId} />
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
    route.name === 'home' ? (
      <>
        <SyncButton />
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
