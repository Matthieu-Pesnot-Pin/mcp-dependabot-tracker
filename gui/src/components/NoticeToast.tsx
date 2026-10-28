import { useNotice } from '../store/useNotice'
import { Icon } from './Icon'

/** Message bref en bas à droite : confirmation ou erreur. */
export function NoticeToast() {
  const notice = useNotice((state) => state.notice)
  const dismiss = useNotice((state) => state.dismiss)
  if (!notice) return null
  return (
    <div key={notice.id} className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <Icon name={notice.kind === 'error' ? 'triangle-alert' : 'info'} />
      <span className="notice-text">{notice.text}</span>
      <button type="button" className="notice-close" onClick={dismiss} aria-label="Fermer le message">
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}
