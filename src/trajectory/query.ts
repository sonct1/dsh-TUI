/**
 * Trajectory query — whole-session structured filtering.
 *
 * The official web trajectory is paged, and its own documentation is explicit
 * that search covers only the currently loaded window. In the terminal the
 * entire event log is already resident, so filtering can be exhaustive — and
 * once it is exhaustive, plain substring search stops being enough. This is a
 * small field language instead:
 *
 * ```
 *   tool:web_search        name equals (case-insensitive)
 *   kind:retry             row kind
 *   turn:9                 owning turn
 *   err:                   failed rows only
 *   run:                   still-running rows only
 *   >10s  <500ms           own duration bounds (ms / s / m suffixes)
 *   tok>1k                 token bounds
 *   anything else          free text over all inspectable record content
 * ```
 *
 * Everything is AND-ed. An unparseable term degrades to free text rather than
 * erroring, so a half-typed query still narrows sensibly while you type.
 */

import { burstErrors, burstRunning, inspectNode } from '../dsh-adapter/trajectory/index.js'
import type { TrajKind, TrajNode } from '../dsh-adapter/types.js'

/** One parsed predicate. */
type Term =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'tool'; readonly value: string }
  | { readonly kind: 'rowKind'; readonly value: string }
  | { readonly kind: 'turn'; readonly value: number }
  | { readonly kind: 'error' }
  | { readonly kind: 'running' }
  | { readonly kind: 'duration'; readonly op: '>' | '<'; readonly ms: number }
  | { readonly kind: 'tokens'; readonly op: '>' | '<'; readonly count: number }

/** A compiled query: the parsed terms plus the raw text they came from. */
export interface TrajQuery {
  readonly raw: string
  readonly terms: readonly Term[]
  /** True when the query selects everything (empty or whitespace only). */
  readonly empty: boolean
}

/** Field prefixes offered in the query hint line. */
export const QUERY_FIELDS = ['tool:', 'kind:', 'turn:', 'err:', 'run:', '>10s', '<1s', 'tok>1k'] as const

/** Parse a duration literal (`500ms`, `2s`, `3m`) into milliseconds. */
function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  switch (match[2]) {
    case 'm': return value * 60_000
    case 'ms': return value
    // A bare number is seconds: `>10` reads as ten seconds, which is what a
    // user scanning for slow calls means.
    default: return value * 1000
  }
}

/** Parse a token literal (`1k`, `20000`, `1.5M`). */
function parseCount(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit = match[2]?.toLowerCase()
  return unit === 'k' ? value * 1000 : unit === 'm' ? value * 1_000_000 : value
}

/**
 * Compile a query string.
 *
 * @param raw - The user's query text.
 * @returns A query that {@link matchesQuery} can evaluate. Never throws.
 */
export function parseQuery(raw: string): TrajQuery {
  const trimmed = raw.trim()
  if (trimmed === '') return { raw, terms: [], empty: true }

  const terms: Term[] = []
  for (const token of trimmed.split(/\s+/)) {
    const lower = token.toLowerCase()

    if (lower === 'err:' || lower === 'error:') { terms.push({ kind: 'error' }); continue }
    if (lower === 'run:' || lower === 'running:') { terms.push({ kind: 'running' }); continue }

    const tool = /^tool:(.+)$/.exec(lower)
    if (tool !== null) { terms.push({ kind: 'tool', value: tool[1]! }); continue }

    const rowKind = /^kind:(.+)$/.exec(lower)
    if (rowKind !== null) { terms.push({ kind: 'rowKind', value: rowKind[1]! }); continue }

    const turn = /^turn:(\d+)$/.exec(lower)
    if (turn !== null) { terms.push({ kind: 'turn', value: Number(turn[1]) }); continue }

    const tokens = /^tok([<>])(.+)$/.exec(lower)
    if (tokens !== null) {
      const count = parseCount(tokens[2]!)
      if (count !== undefined) { terms.push({ kind: 'tokens', op: tokens[1] as '>' | '<', count }); continue }
    }

    const duration = /^([<>])(.+)$/.exec(lower)
    if (duration !== null) {
      const ms = parseDuration(duration[2]!)
      if (ms !== undefined) { terms.push({ kind: 'duration', op: duration[1] as '>' | '<', ms }); continue }
    }

    // Anything unrecognized — including a half-typed `tool:` — is free text.
    terms.push({ kind: 'text', value: lower })
  }
  return { raw, terms, empty: false }
}

/** Total tokens attributed to a row. */
function tokenTotal(node: TrajNode): number {
  const t = node.request?.usage ?? node.tokens
  return t === undefined ? 0 : t.input + t.output + t.think
}

/**
 * Full-text index cached by node identity. The projection mutates nodes only
 * to complete brackets; the record snapshot remains immutable, so the costly
 * inspection/stringification happens once per arriving row, never per key.
 */
const fullTextCache = new WeakMap<TrajNode, { readonly signature: string; readonly text: string }>()

function searchSignature(node: TrajNode): string {
  const members = node.burst?.members ?? [node]
  return members.map(member => [
    member.seq, member.endSeq, member.status, member.detail, member.outcome,
    member.request?.firstTokenTime, member.request?.completionTime,
  ].join('\u0000')).join('\u0001')
}

function fullText(node: TrajNode, events: readonly unknown[]): string {
  const signature = searchSignature(node)
  const cached = fullTextCache.get(node)
  if (cached?.signature === signature) return cached.text
  const members = node.burst?.members ?? [node]
  const text = members.map(member => {
    const detail = inspectNode(member, events as never)
    const sections = detail?.tabs.flatMap(tab => tab.sections.map(section => `${section.title}\n${section.body}`)) ?? []
    return [member.label, member.detail, member.outcome, detail?.title, ...(detail?.facts ?? []), ...sections]
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
  }).join('\n').toLowerCase()
  fullTextCache.set(node, { signature, text })
  return text
}

/** Evaluate one row against one term. */
function matchesTerm(node: TrajNode, term: Term, events: readonly unknown[]): boolean {
  switch (term.kind) {
    case 'text':
      return fullText(node, events).includes(term.value)
    case 'tool':
      return (node.kind === 'tool' || node.kind === 'subtool') && node.label.toLowerCase() === term.value
    case 'rowKind':
      return (node.kind as string) === term.value
    case 'turn':
      return node.turn === term.value
    case 'error':
      return node.status === 'error' || (node.burst !== undefined && burstErrors(node.burst) > 0)
    case 'running':
      return node.status === 'running' || (node.burst !== undefined && burstRunning(node.burst))
    case 'duration': {
      const ms = node.durationMs
      if (ms === undefined) return false
      return term.op === '>' ? ms > term.ms : ms < term.ms
    }
    case 'tokens': {
      const count = tokenTotal(node)
      return term.op === '>' ? count > term.count : count < term.count
    }
  }
}

/** True when a row satisfies every term (an empty query matches everything). */
export function matchesQuery(node: TrajNode, query: TrajQuery, events: readonly unknown[] = []): boolean {
  if (query.empty) return true
  for (const term of query.terms) if (!matchesTerm(node, term, events)) return false
  return true
}

/**
 * Apply a query to the ledger.
 *
 * @returns The matching rows and, in parallel, their original ledger indexes —
 *   the wave band highlights matches in place, so it needs the positions the
 *   rows had before filtering, not after.
 */
export function applyQuery(
  nodes: readonly TrajNode[],
  query: TrajQuery,
  events: readonly unknown[] = [],
): { rows: TrajNode[]; indexes: number[] } {
  if (query.empty) return { rows: [...nodes], indexes: nodes.map((_, index) => index) }
  const rows: TrajNode[] = []
  const indexes: number[] = []
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!
    if (matchesQuery(node, query, events)) {
      rows.push(node)
      indexes.push(index)
    }
  }
  return { rows, indexes }
}

/** Row kinds offered as `kind:` completions, in ledger-usefulness order. */
export const QUERY_KINDS: readonly TrajKind[] = [
  'tool', 'subtool', 'retry', 'assistant', 'thinking', 'user',
  'approval', 'system', 'context', 'compaction', 'request', 'turn', 'step', 'todo',
]
