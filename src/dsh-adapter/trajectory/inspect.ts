/**
 * Inspector detail — full content, resolved on demand at the adapter boundary.
 */

import { asRawEvents, readCompaction, readRequestHeader, readRetry, type RawTrajEvent } from './guards.js'
import type { TrajNode } from './types.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Stable tab identities consumed by the terminal-only inspector. */
export type InspectTabId =
  | 'overview'
  | 'system-prompt'
  | 'tools'
  | 'schema'
  | 'usage'
  | 'diff'
  | 'options'
  | 'input'
  | 'output'
  | 'timing'
  | 'raw'

/** One titled block inside an inspector tab. */
export interface InspectSection {
  readonly title: string
  readonly body: string
  readonly tone?: 'error' | 'dim'
}

/** A detail tab is emitted only when it has useful content. */
export interface InspectTab {
  readonly id: InspectTabId
  readonly label: string
  readonly sections: readonly InspectSection[]
}

/** Everything the inspector shows for one row. */
export interface InspectDetail {
  readonly title: string
  readonly facts: readonly string[]
  readonly tabs: readonly InspectTab[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Binary search for an event by seq; the log is seq-monotonic. */
function findBySeq(events: readonly RawTrajEvent[], seq: number): RawTrajEvent | undefined {
  let low = 0
  let high = events.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const candidate = events[mid]!
    if (candidate.seq === seq) return candidate
    if (candidate.seq < seq) low = mid + 1
    else high = mid - 1
  }
  return undefined
}

function prettyJson(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return text
  }
}

/** JSON output for raw payloads, including values JSON cannot serialize. */
const RAW_LIMIT = 32_000
const TEXT_LIMIT = 8_000

/** Serialize inspector raw safely: retain useful text, redact secrets and mark truncation. */
function rawValue(value: unknown): string {
  const redact = (key: string, item: unknown): unknown =>
    /(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|bearer)/i.test(key)
      ? '[REDACTED]'
      : item
  try {
    const result = typeof value === 'string' ? value : JSON.stringify(value, (key, item) => redact(key, item), 2) ?? String(value)
    if (result.length <= RAW_LIMIT) return result
    return `${result.slice(0, RAW_LIMIT)}\n[TRUNCATED: ${result.length - RAW_LIMIT} characters omitted]`
  } catch {
    return String(value)
  }
}

function textValue(value: string): string {
  return value.length <= TEXT_LIMIT ? value : `${value.slice(0, TEXT_LIMIT)}\n[TRUNCATED: ${value.length - TEXT_LIMIT} characters omitted]`
}

/** Describe one non-text content block without silently losing it. */
function blockLabel(block: Record<string, unknown>): string {
  const type = typeof block.type === 'string' ? block.type : 'unknown'
  if (type === 'image' || type === 'image_url') {
    const source = typeof block.url === 'string' ? block.url : typeof block.source === 'string' ? block.source : ''
    return `[image${source === '' ? '' : `: ${source}`}]`
  }
  if (type === 'tool_use' || type === 'tool_call') {
    const name = typeof block.name === 'string' ? ` ${block.name}` : ''
    return `[${type}${name}]`
  }
  return `[${type} block: ${rawValue(block)}]`
}

/**
 * Collect every message content block. Official tool results wrap their blocks
 * in an outer result block's `content`; direct text fixtures remain accepted.
 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    if (!isRecord(item)) {
      parts.push(`[non-text content: ${rawValue(item)}]`)
      continue
    }
    if (typeof item.text === 'string') parts.push(item.text)
    const nested = item.content
    if (nested !== undefined) {
      const value = contentText(nested)
      if (value !== '') parts.push(value)
      continue
    }
    if (typeof item.text !== 'string') parts.push(blockLabel(item))
  }
  return parts.join('\n')
}

function messageContent(data: unknown): string {
  if (!isRecord(data)) return ''
  const message = isRecord(data.message) ? data.message : data
  return contentText(message.content)
}

function timingSections(node: TrajNode): InspectSection[] {
  const facts: string[] = [`started: ${new Date(node.time).toISOString()}`]
  if (node.durationMs !== undefined) facts.push(`duration: ${node.durationMs}ms`)
  if (node.request?.firstTokenTime !== undefined) {
    const ttft = Math.max(0, node.request.firstTokenTime - node.time)
    facts.push(`TTFT: ${ttft}ms`)
    const completion = node.request.completionTime
    if (completion !== undefined) {
      const generation = Math.max(0, completion - node.request.firstTokenTime)
      facts.push(`generation: ${generation}ms`)
      const tokens = node.request.usage?.output
      if (tokens !== undefined && generation > 0) facts.push(`throughput: ${(tokens / (generation / 1000)).toFixed(2)} tok/s`)
    }
  }
  if (node.status !== undefined) facts.push(`status: ${node.status}`)
  const tokens = node.request?.usage ?? node.tokens
  if (tokens !== undefined) {
    const { input, output, think, cacheRead, cacheWrite } = tokens
    facts.push(`tokens: input ${input}, output ${output}, thinking ${think}, cache read ${cacheRead}, cache write ${cacheWrite}`)
  }
  return [{ title: 'timing', body: facts.join('\n'), tone: 'dim' }]
}

const TAB_LABELS: Readonly<Record<InspectTabId, string>> = {
  overview: 'Overview',
  'system-prompt': 'System Prompt',
  tools: 'Tools',
  schema: 'Schema',
  usage: 'Usage',
  diff: 'Diff',
  options: 'Options',
  input: 'Input',
  output: 'Output',
  timing: 'Timing',
  raw: 'Raw',
}

function addTab(tabs: InspectTab[], id: InspectTabId, sections: InspectSection[]): void {
  if (sections.length > 0) tabs.push({ id, label: TAB_LABELS[id], sections })
}

function previousRequestHeader(events: readonly RawTrajEvent[], seq: number): RawTrajEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.seq >= seq || event.type !== 'request/header') continue
    if (readRequestHeader(event.data) !== undefined) return event
  }
  return undefined
}

function promptDiff(before: string, after: string): string {
  if (before === after) return 'No system-prompt text change'
  const left = before.split('\n')
  const right = after.split('\n')
  const lines: string[] = []
  const count = Math.max(left.length, right.length)
  for (let index = 0; index < count; index++) {
    if (left[index] === right[index]) {
      if (left[index] !== undefined) lines.push(`  ${left[index]}`)
      continue
    }
    if (left[index] !== undefined) lines.push(`- ${left[index]}`)
    if (right[index] !== undefined) lines.push(`+ ${right[index]}`)
  }
  return lines.join('\n')
}

/** Resolve the full terminal-friendly detail for one ledger row. */
export function inspectNode(node: TrajNode, events: readonly SessionEvent[]): InspectDetail {
  const raw = asRawEvents(events)
  const open = findBySeq(raw, node.seq)
  const close = node.endSeq === undefined ? undefined : findBySeq(raw, node.endSeq)
  const data = open?.data
  const facts: string[] = []
  if (node.turn > 0) facts.push(node.step === undefined ? `turn ${node.turn}` : `turn ${node.turn} · step ${node.step}`)
  if (node.callId !== undefined) facts.push(node.callId.slice(0, 12))
  if (node.parentCallId !== undefined) facts.push(`parent: ${node.parentCallId}`)
  if (node.rootCallId !== undefined) facts.push(`root: ${node.rootCallId}`)
  if (node.depth !== undefined) facts.push(`depth: ${node.depth}`)

  const overview: InspectSection[] = []
  const input: InspectSection[] = []
  const output: InspectSection[] = []
  const systemPrompt: InspectSection[] = []
  const tools: InspectSection[] = []
  const schema: InspectSection[] = []
  const usage: InspectSection[] = []
  const diff: InspectSection[] = []
  const options: InspectSection[] = []
  const rawSections: InspectSection[] = []

  if (node.detail !== undefined && node.detail !== '') input.push({ title: 'input', body: prettyJson(textValue(node.detail)) })
  if (node.errorCode !== undefined) overview.push({ title: 'error', body: node.errorCode, tone: 'error' })
  const requestUsage = node.request?.usage ?? node.tokens
  if (requestUsage !== undefined) {
    usage.push({ title: 'usage', body: `input: ${requestUsage.input}\noutput: ${requestUsage.output}\nreasoning: ${requestUsage.think}\ncache read: ${requestUsage.cacheRead}\ncache write: ${requestUsage.cacheWrite}` })
  }

  switch (node.kind) {
    case 'tool':
    case 'subtool': {
      const headerEvent = node.request?.headerSeq === undefined ? undefined : findBySeq(raw, node.request.headerSeq)
      const header = headerEvent === undefined ? undefined : readRequestHeader(headerEvent.data)
      const tool = header?.tools.find(item => isRecord(item) && item.name === node.label)
      if (tool !== undefined) schema.push({ title: `${node.label} schema`, body: rawValue(tool) })
      overview.push({
        title: 'call',
        body: [
          `name: ${node.label}`,
          `status: ${node.status ?? 'unknown'}`,
          node.callId === undefined ? undefined : `call id: ${node.callId}`,
        ].filter((value): value is string => value !== undefined).join('\n'),
        tone: node.status === 'error' ? 'error' : undefined,
      })
      const body = messageContent(close?.data)
      if (body !== '') output.push({ title: 'output', body, tone: node.status === 'error' ? 'error' : undefined })
      else if (node.outcome !== undefined && node.outcome !== '') output.push({ title: 'output', body: node.outcome, tone: node.status === 'error' ? 'error' : undefined })
      else if (close !== undefined) output.push({ title: 'output', body: 'No output', tone: 'dim' })
      break
    }
    case 'request': {
      overview.push({
        title: 'request',
        body: [
          `status: ${node.status ?? 'unknown'}`,
          node.request?.provider === undefined ? undefined : `provider: ${node.request.provider}`,
          node.request?.model === undefined ? undefined : `model: ${node.request.model}`,
          node.errorCode === undefined ? undefined : `error: ${node.errorCode}`,
        ].filter((value): value is string => value !== undefined).join('\n'),
        tone: node.status === 'error' ? 'error' : undefined,
      })
      const headerEvent = node.request?.headerSeq === undefined ? undefined : findBySeq(raw, node.request.headerSeq)
      const header = headerEvent === undefined ? undefined : readRequestHeader(headerEvent.data)
      if (header?.config !== undefined) options.push({ title: 'request options', body: rawValue(header.config) })
      break
    }
    case 'retry': {
      const payload = open === undefined ? undefined : readRetry(open.data)
      if (payload !== undefined) {
        facts.push(`${node.attempts ?? 1} attempts`)
        if (payload.provider !== undefined) facts.push(payload.provider)
        overview.push({ title: 'cause', body: `${payload.code ?? 'unknown'} — ${payload.message ?? ''}`.trim(), tone: 'error' })
      }
      const ladder: string[] = []
      for (const event of raw) {
        if (event.type !== 'llm/retry') continue
        const attempt = readRetry(event.data)
        if (attempt !== undefined && payload !== undefined && attempt.retryId === payload.retryId) ladder.push(`#${attempt.retry} → ${Math.round(attempt.delayMs)}ms`)
      }
      if (ladder.length > 0) overview.push({ title: 'backoff', body: ladder.join('  ') })
      break
    }
    case 'system': {
      if (open?.type === 'request/header') {
        const header = readRequestHeader(open.data)
        if (header !== undefined) {
          overview.push({
            title: 'request prompt',
            body: [
              `change: ${node.label}`,
              header.provider === undefined ? undefined : `provider: ${header.provider}`,
              header.model === undefined ? undefined : `model: ${header.model}`,
              header.effort === undefined ? undefined : `effort: ${header.effort}`,
              `tools: ${header.tools.length}`,
            ].filter((value): value is string => value !== undefined).join('\n'),
          })
          systemPrompt.push({
            title: 'system prompt',
            body: header.system === '' ? 'No system prompt in this request' : header.system,
            tone: header.system === '' ? 'dim' : undefined,
          })
          tools.push({
            title: `tool catalog · ${header.tools.length}`,
            body: header.tools.length === 0 ? 'No tools in this request' : rawValue(header.tools),
            tone: header.tools.length === 0 ? 'dim' : undefined,
          })
          if (header.config !== undefined) options.push({ title: 'request options', body: rawValue(header.config) })
          const previousEvent = previousRequestHeader(raw, open.seq)
          const previous = previousEvent === undefined ? undefined : readRequestHeader(previousEvent.data)
          if (previous !== undefined) {
            diff.push({ title: 'system prompt', body: promptDiff(previous.system, header.system) })
            if (JSON.stringify(previous.tools) !== JSON.stringify(header.tools)) {
              diff.push({ title: 'tools', body: `${rawValue(previous.tools)}\n→\n${rawValue(header.tools)}` })
            }
          }
        }
      } else if (node.detail !== undefined && node.detail !== '') {
        overview.push({ title: 'detail', body: node.detail })
      }
      break
    }
    case 'compaction': {
      const start = readCompaction(open?.data)
      const lifecycle = raw.filter(event =>
        event.seq >= node.seq &&
        (node.endSeq === undefined || event.seq <= node.endSeq) &&
        event.type.startsWith('compaction/'),
      )
      let summary = ''
      let rawOutput = ''
      let error = ''
      for (const event of lifecycle) {
        const payload = readCompaction(event.data)
        summary ||= payload.summary ?? ''
        rawOutput ||= payload.output ?? ''
        error ||= payload.error ?? ''
        rawSections.push({ title: `event ${event.type} · seq ${event.seq}`, body: rawValue(event.data), tone: 'dim' })
      }
      overview.push({
        title: 'compaction',
        body: [
          start.reason === undefined ? undefined : `reason: ${start.reason}`,
          `status: ${node.status ?? 'unknown'}`,
          node.outcome === undefined ? undefined : `result: ${node.outcome}`,
          error === '' ? undefined : `error: ${error}`,
        ].filter((value): value is string => value !== undefined).join('\n'),
        tone: node.status === 'error' ? 'error' : undefined,
      })
      if (summary !== '') output.push({ title: 'summary', body: textValue(summary) })
      if (rawOutput !== '') output.push({ title: 'raw output', body: textValue(rawOutput), tone: 'dim' })
      break
    }
    case 'approval':
      if (node.detail !== undefined) overview.push({ title: 'reason', body: node.detail })
      if (node.outcome !== undefined) overview.push({ title: 'outcome', body: node.outcome, tone: node.status === 'error' ? 'error' : undefined })
      break
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'context': {
      const body = messageContent(data)
      overview.push({ title: node.kind, body: body === '' ? (node.detail ?? '') : body })
      break
    }
    default:
      if (node.outcome !== undefined && node.outcome !== '') overview.push({ title: 'outcome', body: node.outcome })
      break
  }

  if (node.kind !== 'compaction') {
    if (open !== undefined) rawSections.push({ title: `event ${open.type} · seq ${open.seq}`, body: rawValue(open.data), tone: 'dim' })
    if (close !== undefined) rawSections.push({ title: `result ${close.type} · seq ${close.seq}`, body: rawValue(close.data), tone: 'dim' })
  }

  const tabs: InspectTab[] = []
  if (systemPrompt.length > 0) {
    // Prompt rows open on their primary payload like the web trajectory.
    addTab(tabs, 'system-prompt', systemPrompt)
    addTab(tabs, 'tools', tools)
    addTab(tabs, 'diff', diff)
    addTab(tabs, 'options', options)
    addTab(tabs, 'overview', overview)
  } else {
    addTab(tabs, 'overview', overview)
  }
  addTab(tabs, 'input', input)
  addTab(tabs, 'output', output)
  addTab(tabs, 'schema', schema)
  addTab(tabs, 'usage', usage)
  addTab(tabs, 'timing', timingSections(node))
  addTab(tabs, 'raw', rawSections)
  if (tabs.length === 0) tabs.push({ id: 'overview', label: 'Overview', sections: [{ title: 'detail', body: 'No detail available', tone: 'dim' }] })

  return { title: node.label === '' ? node.kind : node.label, facts, tabs }
}
