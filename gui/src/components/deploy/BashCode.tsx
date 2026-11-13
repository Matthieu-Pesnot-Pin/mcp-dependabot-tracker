import Prism from 'prismjs'
import 'prismjs/components/prism-bash'
import type { ReactNode } from 'react'

type Kind = 'cmd' | 'danger' | 'opt' | 'str' | 'var' | 'op' | 'num' | 'comment'

/** Commandes à risque (droits, suppression, écriture disque, arrêt), signalées par la couleur « sensible ». */
const SENSITIVE = new Set([
  'sudo', 'su', 'doas', 'rm', 'rmdir', 'shred', 'dd', 'mkfs', 'wipefs', 'fdisk', 'parted', 'truncate',
  'chmod', 'chown', 'chgrp', 'kill', 'killall', 'pkill', 'shutdown', 'reboot', 'halt', 'poweroff',
])

/** Mots après lesquels le mot suivant est de nouveau une commande. */
const PREFIXES = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'nice', 'ionice', 'xargs', 'exec', 'watch', 'timeout'])

/** Options de sudo et doas suivies d'une valeur, qui n'est pas la commande (`sudo -u www-data php`). */
const PREFIX_OPTIONS_WITH_VALUE = new Set(['-u', '-g', '-U', '-C', '-D', '-h', '-p', '-r', '-t'])

/** Opérateurs et ponctuation après lesquels commence une nouvelle commande. */
const SEPARATORS = new Set(['|', '||', '&&', '&', '|&', ';', '(', '$(', '`', '{', 'then', 'do', 'else'])

const KIND_OF_TYPE: Record<string, Kind> = {
  parameter: 'opt',
  string: 'str',
  variable: 'var',
  environment: 'var',
  'assign-left': 'var',
  operator: 'op',
  punctuation: 'op',
  'file-descriptor': 'op',
  keyword: 'op',
  number: 'num',
  boolean: 'num',
  comment: 'comment',
  shebang: 'comment',
}

interface Piece {
  text: string
  kind: Kind | null
  children?: Piece[]
}

function commandKind(word: string): Kind {
  const name = word.slice(word.lastIndexOf('/') + 1)
  return SENSITIVE.has(name) || name.startsWith('mkfs.') ? 'danger' : 'cmd'
}

function textOf(content: string | Prism.Token | Prism.TokenStream): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(textOf).join('')
  return textOf(content.content)
}

function nested(content: string | Prism.Token | Prism.TokenStream): Piece[] {
  if (typeof content === 'string') return [{ text: content, kind: null }]
  if (Array.isArray(content)) return content.flatMap(nested)
  return [{ text: '', kind: KIND_OF_TYPE[content.type] ?? null, children: nested(content.content) }]
}

/**
 * Découpe un script en morceaux colorables, comme SSH Gate. Prism repère
 * options, chaînes, variables, opérateurs et commentaires ; le nom de commande
 * est reconnu par sa position (début de ligne, après un séparateur ou un
 * préfixe comme sudo).
 */
function tokenizeScript(script: string): Piece[] {
  const pieces: Piece[] = []
  let expectCommand = true
  let skipValue = false
  let previous = ''

  for (const token of Prism.tokenize(script, Prism.languages.bash)) {
    const escaped = previous === '\\'
    previous = typeof token === 'string' ? token : textOf(token.content).trim()
    if (typeof token === 'string') {
      for (const part of token.split(/(\s+)/)) {
        if (!part) continue
        if (!/\S/.test(part)) {
          if (part.includes('\n') && !escaped) {
            expectCommand = true
            skipValue = false
          }
          pieces.push({ text: part, kind: null })
        } else if (expectCommand && !skipValue) {
          pieces.push({ text: part, kind: commandKind(part) })
          expectCommand = PREFIXES.has(part) || SEPARATORS.has(part)
        } else {
          skipValue = false
          pieces.push({ text: part, kind: null })
        }
      }
      continue
    }

    const text = textOf(token.content).trim()
    if (token.type === 'function' || token.type === 'builtin') {
      if (expectCommand && !skipValue) {
        pieces.push({ text, kind: commandKind(text) })
        expectCommand = PREFIXES.has(text)
      } else {
        skipValue = false
        pieces.push(...nested(token.content))
      }
      continue
    }

    pieces.push({ text: '', kind: KIND_OF_TYPE[token.type] ?? null, children: nested(token.content) })
    if (token.type === 'comment' || token.type === 'shebang') continue
    if (SEPARATORS.has(text) && !escaped) {
      expectCommand = true
      skipValue = false
    } else if (token.type === 'parameter') {
      skipValue = expectCommand && PREFIX_OPTIONS_WITH_VALUE.has(text)
    } else if (skipValue) {
      skipValue = false
    } else if (token.type !== 'keyword' && token.type !== 'assign-left') {
      expectCommand = false
    }
  }
  return pieces
}

function render(pieces: Piece[], prefix: string): ReactNode[] {
  return pieces.map((piece, index) => {
    const key = `${prefix}${index}`
    const content = piece.children ? render(piece.children, `${key}.`) : piece.text
    return piece.kind ? (
      <span key={key} className={`tk-${piece.kind}`}>
        {content}
      </span>
    ) : (
      <span key={key}>{content}</span>
    )
  })
}

/** Script coloré, dans la palette « sobre » de SSH Gate. Le conteneur doit conserver les sauts de ligne. */
export function BashText({ script }: { script: string }) {
  return <span className="hl">{render(tokenizeScript(script), '')}</span>
}
