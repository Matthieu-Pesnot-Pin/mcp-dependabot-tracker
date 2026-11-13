import { SCRIPT_VARIABLES } from '@shared/schemas/deploy.schema'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '../Icon'
import { lineCount } from '../../utils/script'
import { BashText } from './BashCode'

/** Hauteur d'une ligne de code, en pixels : la gouttière, le texte coloré et le champ s'alignent dessus. */
const LINE_HEIGHT = 22

/** Retrait inséré par Tab. */
const INDENT = '  '

function Gutter({ lines, active }: { lines: number; active: number | null }) {
  return (
    <div className="code-gutter" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className={index + 1 === active ? 'is-active' : undefined}>
          {index + 1}
        </span>
      ))}
    </div>
  )
}

/** Marque d'une ligne pendant ou après une exécution. */
export interface LineMark {
  line: number
  state: 'running' | 'failed' | 'done'
  /** Texte affiché au bout de la ligne. */
  label: string
}

/**
 * Script coloré en lecture, avec ses numéros de ligne. Pendant une exécution,
 * la ligne en cours est surlignée et les suivantes sont estompées.
 */
export function ScriptView({ script, mark, dimAfter = false, active = false }: { script: string; mark?: LineMark | null; dimAfter?: boolean; active?: boolean }) {
  const lines = lineCount(script)
  return (
    <div className={`code-box${active ? ' is-active' : ''}`}>
      <Gutter lines={lines} active={mark?.line ?? null} />
      <div className="code-scroll">
        <div className="code-layer">
          {mark && (
            <div className={`code-band is-${mark.state}`} style={{ top: (mark.line - 1) * LINE_HEIGHT }}>
              <span className="code-band-label">{mark.label}</span>
            </div>
          )}
          <pre className="code-text">
            <BashText script={script} />
          </pre>
          {mark && dimAfter && mark.line < lines && <div className="code-dim" style={{ top: mark.line * LINE_HEIGHT }} />}
        </div>
      </div>
    </div>
  )
}

interface ScriptEditorProps {
  initial: string
  busy: boolean
  onSave: (script: string) => void
  onCancel: () => void
}

/**
 * Éditeur du script : un champ transparent posé sur le texte coloré, qui défile
 * avec lui. Tab indente, Ctrl+S enregistre, Échap annule ; un clic sur une
 * variable l'insère au curseur.
 */
export function ScriptEditor({ initial, busy, onSave, onCancel }: ScriptEditorProps) {
  const [script, setScript] = useState(initial)
  const [line, setLine] = useState(1)
  const area = useRef<HTMLTextAreaElement>(null)
  const lines = lineCount(script)
  const longest = Math.max(...script.split('\n').map((text) => text.length), 1)

  useEffect(() => area.current?.focus(), [])

  function updateLine() {
    const field = area.current
    if (field) setLine(field.value.slice(0, field.selectionStart).split('\n').length)
  }

  function insert(text: string) {
    const field = area.current
    if (!field) return
    const { selectionStart: start, selectionEnd: end } = field
    const next = script.slice(0, start) + text + script.slice(end)
    setScript(next)
    requestAnimationFrame(() => {
      field.focus()
      field.selectionStart = field.selectionEnd = start + text.length
      updateLine()
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      insert(INDENT)
    } else if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      if (!busy) onSave(script)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }

  return (
    <>
      <div className="section-head">
        <p className="section-label section-label-strong">Script de déploiement</p>
        <span className="hint-inline">bash · {lines} {lines > 1 ? 'lignes' : 'ligne'}</span>
      </div>
      <div className="code-box is-active is-editing">
        <Gutter lines={lines} active={line} />
        <div className="code-scroll">
          <div className="code-layer" style={{ width: `calc(${longest + 2}ch + 32px)`, height: lines * LINE_HEIGHT + 32 }}>
            <div className="code-band is-cursor" style={{ top: (line - 1) * LINE_HEIGHT }} />
            <pre className="code-text" aria-hidden="true">
              <BashText script={script.endsWith('\n') ? `${script} ` : script} />
            </pre>
            <textarea
              ref={area}
              className="code-input"
              value={script}
              wrap="off"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-label="Script de déploiement"
              onChange={(event) => {
                setScript(event.target.value)
                updateLine()
              }}
              onKeyDown={onKeyDown}
              onKeyUp={updateLine}
              onClick={updateLine}
              onSelect={updateLine}
            />
          </div>
        </div>
      </div>
      <div className="editor-foot">
        <div className="editor-vars">
          <span className="hint-inline">Variables</span>
          {SCRIPT_VARIABLES.map((variable) => (
            <button key={variable.name} type="button" className="var-chip mono" title={variable.description} onClick={() => insert(`$${variable.name}`)}>
              ${variable.name}
            </button>
          ))}
        </div>
        <div className="editor-actions">
          <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>
            Annuler
          </button>
          <button type="button" className="button button-primary editor-save" onClick={() => onSave(script)} disabled={busy}>
            <Icon name="check" />
            Enregistrer
          </button>
        </div>
      </div>
      <p className="hint">
        Le script s'exécute avec bash sur le serveur, depuis le dossier personnel de l'utilisateur, l'entrée venant de /dev/null. Tab indente, Ctrl+S
        enregistre, Échap annule.
      </p>
    </>
  )
}
