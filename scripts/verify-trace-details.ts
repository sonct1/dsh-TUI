/**
 * Trajectory detail regressions: official nested tool results, full wrapping,
 * conditional tabs, and per-member burst inspection.
 *
 * Run: node --import tsx/esm scripts/verify-trace-details.ts
 */
import { buildTrajectory, extendTrajectory, inspectNode } from '../src/dsh-adapter/trajectory/index.js'
import { applyQuery, parseQuery } from '../src/trajectory/query.js'
import { wrapInspectorLine } from '../src/components/trajectory/Inspector.js'
import { stringWidth } from '../src/ink/stringWidth.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) failed += 1
}

const T0 = 1_700_000_000_000
let seq = 0
const events: Record<string, unknown>[] = []
function event(type: string, data: unknown): void {
  events.push({ type, seq: ++seq, time: T0 + seq * 10, data })
}

const longOutput = `HEAD-${'界'.repeat(80)}-${'x'.repeat(180)}-TAIL`
event('request/header', {
  reason: 'initial',
  header: {
    system: 'SYSTEM-PROMPT-INITIAL',
    config: { provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'max', maxTokens: 4096, apiKey: 'DO-NOT-SHOW' },
    tools: [{ name: 'web_fetch', description: 'Fetch a URL', parameters: { type: 'object' } }],
  },
})
event('turn/start', { turn: 1 })
event('step/start', { turn: 1, step: 1 })
event('tool/call', {
  turn: 1,
  step: 1,
  callId: 'nested-result',
  name: 'web_fetch',
  arguments: '{"url":"https://example.com"}',
})
event('tool/result', {
  turn: 1,
  step: 1,
  message: {
    source: { callId: 'nested-result' },
    content: [{
      type: 'tool_result',
      isError: true,
      content: [
        { type: 'text', text: longOutput },
        { type: 'text', text: 'SECOND-BLOCK' },
        { type: 'image', source: 'artifact://preview.png' },
      ],
    }],
  },
})

for (let index = 0; index < 3; index++) {
  const callId = `burst-${index}`
  event('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'web_search',
    arguments: JSON.stringify({ query: `query-${index}` }),
  })
  event('tool/result', {
    turn: 1,
    step: 1,
    message: {
      source: { callId },
      content: [{
        type: 'tool_result',
        content: [{ type: 'text', text: `BURST-OUTPUT-${index}` }],
      }],
    },
  })
}
event('assistant/message', {
  turn: 1,
  step: 1,
  message: { content: [{ type: 'text', text: 'FINAL-ASSISTANT' }] },
  usage: { inputTokens: 1200, outputTokens: 240, reasoningTokens: 80, cacheReadTokens: 600, cacheWriteTokens: 10 },
})
event('step/end', { turn: 1, step: 1 })

// Request that fails before any assistant message: must remain visible.
event('step/start', { turn: 1, step: 2 })
event('assistant/chunk', { turn: 1, step: 2, chunk: { type: 'reasoning-delta', text: 'PARTIAL-REASONING-TAIL' } })
event('assistant/chunk', { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'PARTIAL-ANSWER-TAIL' } })
event('request/error', { turn: 1, step: 2, error: { code: 'UPSTREAM_FAILURE' }, usage: { inputTokens: 50, outputTokens: 7 } })
event('step/end', { turn: 1, step: 2 })

// Nested subtools retain root/parent/depth.
event('tool/code-dispatch-start', { rootCallId: 'nested-result', parentCallId: 'nested-result', subCallId: 'sub-1', name: 'child_one', arguments: { value: 1 } })
event('tool/code-dispatch-start', { rootCallId: 'nested-result', parentCallId: 'sub-1', subCallId: 'sub-2', name: 'child_two', arguments: { value: 2 } })
event('tool/code-dispatch', { rootCallId: 'nested-result', parentCallId: 'sub-1', subCallId: 'sub-2', name: 'child_two', content: [{ type: 'text', text: 'CHILD-TWO-OUTPUT' }] })
event('tool/code-dispatch', { rootCallId: 'nested-result', parentCallId: 'nested-result', subCallId: 'sub-1', name: 'child_one', content: [{ type: 'text', text: 'CHILD-ONE-OUTPUT' }] })

// Full compaction lifecycle.
event('compaction/start', { compactionId: 'cmp-1', reason: 'threshold' })
event('compaction/summary', {
  compactionId: 'cmp-1',
  summary: 'COMPACTION-SUMMARY',
  rawOutput: 'COMPACTION-RAW-OUTPUT',
  provider: 'deepseek-official',
  model: 'deepseek-v4',
  usage: { inputTokens: 333, outputTokens: 44 },
})
event('compaction/end', { compactionId: 'cmp-1', removed: 17 })

event('request/header', {
  reason: 'change',
  header: {
    system: 'SYSTEM-PROMPT-CHANGED',
    config: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high', maxTokens: 8192 },
    tools: [
      { name: 'web_fetch', description: 'Fetch a URL', parameters: { type: 'object' } },
      { name: 'web_search', description: 'Search the web', parameters: { type: 'object' } },
    ],
  },
})
event('turn/end', { turn: 1, reason: { kind: 'completed' } })

const sessionEvents = events as unknown as readonly SessionEvent[]
const build = buildTrajectory(sessionEvents)
for (let split = 0; split <= sessionEvents.length; split++) {
  const first = buildTrajectory(sessionEvents.slice(0, split))
  const incremental = extendTrajectory(first, sessionEvents)
  check(
    `incremental request lifecycle equals full build at split ${split}`,
    JSON.stringify(incremental.nodes) === JSON.stringify(build.nodes),
  )
}
const promptRows = build.nodes.filter(node => node.kind === 'system' && node.seq > 0)
check('initial request header becomes a system-prompt row', promptRows.some(node => node.label === 'initial prompt'))
check('changed request header becomes a prompt-change row', promptRows.some(node => node.label === 'system + tools changed'))
const initialPrompt = promptRows.find(node => node.label === 'initial prompt')
if (initialPrompt !== undefined) {
  const detail = inspectNode(initialPrompt, sessionEvents)
  check('initial prompt exposes System Prompt tab', detail.tabs.find(tab => tab.id === 'system-prompt')?.sections.some(section => section.body.includes('SYSTEM-PROMPT-INITIAL')) === true)
  check('initial prompt exposes Tools tab', detail.tabs.find(tab => tab.id === 'tools')?.sections.some(section => section.body.includes('web_fetch')) === true)
  check('initial prompt exposes Options tab', detail.tabs.find(tab => tab.id === 'options')?.sections.some(section => section.body.includes('maxTokens')) === true)
  const options = detail.tabs.find(tab => tab.id === 'options')?.sections.map(section => section.body).join('\n') ?? ''
  check('raw options redact credentials', options.includes('[REDACTED]') && !options.includes('DO-NOT-SHOW'), options)
}
const changedPrompt = promptRows.find(node => node.label === 'system + tools changed')
if (changedPrompt !== undefined) {
  const detail = inspectNode(changedPrompt, sessionEvents)
  check('changed prompt exposes new system prompt', detail.tabs.find(tab => tab.id === 'system-prompt')?.sections.some(section => section.body.includes('SYSTEM-PROMPT-CHANGED')) === true)
  const diff = detail.tabs.find(tab => tab.id === 'diff')?.sections.map(section => section.body).join('\n') ?? ''
  check('changed prompt exposes system prompt diff', diff.includes('- SYSTEM-PROMPT-INITIAL') && diff.includes('+ SYSTEM-PROMPT-CHANGED'), diff)
  check('changed prompt diff includes tool catalog changes', diff.includes('web_search'), diff.slice(-120))
}
const requestOnly = build.nodes.find(node => node.kind === 'request' && node.step === 2)
check('failed request without assistant remains visible', requestOnly?.status === 'error', requestOnly?.status)
if (requestOnly !== undefined) {
  check('request-only row keeps real-schema usage', requestOnly.request?.usage?.input === 50 && requestOnly.request.usage.output === 7, JSON.stringify(requestOnly.request?.usage))
  const detail = inspectNode(requestOnly, sessionEvents)
  const timing = detail.tabs.find(tab => tab.id === 'timing')?.sections.map(section => section.body).join('\n') ?? ''
  check('request-only row exposes timing', timing.includes('TTFT:') && timing.includes('status: error'), timing)
}
check('interrupted reasoning is preserved', build.nodes.some(node => node.kind === 'thinking' && node.detail?.includes('PARTIAL-REASONING-TAIL')))
check('interrupted assistant output is preserved', build.nodes.some(node => node.kind === 'assistant' && node.detail?.includes('PARTIAL-ANSWER-TAIL')))
check('final assistant reads real provider usage fields', build.nodes.some(node => node.kind === 'assistant' && node.tokens?.input === 1200 && node.tokens.output === 240 && node.tokens.think === 80 && node.tokens.cacheRead === 600))

const childOne = build.nodes.find(node => node.subCallId === 'sub-1')
const childTwo = build.nodes.find(node => node.subCallId === 'sub-2')
check('first-level subtool retains hierarchy', childOne?.parentCallId === 'nested-result' && childOne.rootCallId === 'nested-result' && childOne.depth === 1, JSON.stringify(childOne))
check('nested subtool retains hierarchy depth', childTwo?.parentCallId === 'sub-1' && childTwo.rootCallId === 'nested-result' && childTwo.depth === 2, JSON.stringify(childTwo))

const compaction = build.nodes.find(node => node.kind === 'compaction')
check('compaction row captures summary lifecycle', compaction?.outcome === 'COMPACTION-SUMMARY', compaction?.outcome)
if (compaction !== undefined) {
  const detail = inspectNode(compaction, sessionEvents)
  const raw = detail.tabs.find(tab => tab.id === 'raw')?.sections.map(section => section.body).join('\n') ?? ''
  check('compaction detail retains summary event payload', raw.includes('COMPACTION-SUMMARY'), raw.slice(-160))
  check('compaction usage uses real provider fields', compaction.request?.usage?.input === 333 && compaction.request.usage.output === 44, JSON.stringify(compaction.request?.usage))
}

const nested = build.nodes.find(node => node.callId === 'nested-result')
check('nested tool row exists', nested !== undefined)

if (nested !== undefined) {
  check('ledger preview reads nested tool-result text', nested.outcome === longOutput, nested.outcome?.slice(-20))
  check('nested tool-result error marks the row failed', nested.status === 'error', nested.status)
  const detail = inspectNode(nested, sessionEvents)
  const output = detail.tabs.find(tab => tab.id === 'output')?.sections.map(section => section.body).join('\n') ?? ''
  check('tool detail exposes an Output tab', detail.tabs.some(tab => tab.id === 'output'))
  const schema = detail.tabs.find(tab => tab.id === 'schema')?.sections.map(section => section.body).join('\n') ?? ''
  check('tool detail exposes call-time Schema tab', schema.includes('web_fetch') && schema.includes('Fetch a URL'), schema)
  check('output preserves the long first text block', output.includes(longOutput))
  check('output preserves later text blocks', output.includes('SECOND-BLOCK'))
  check('output represents non-text image blocks', output.includes('artifact://preview.png'), output.slice(-80))
  check('raw tab preserves the closing event', detail.tabs.find(tab => tab.id === 'raw')?.sections.some(section => section.title.includes('tool/result')) === true)
}

check('full-text search reaches long output tail', applyQuery(build.nodes, parseQuery('TAIL'), sessionEvents).rows.some(node => node.callId === 'nested-result'))
check('full-text search reaches system prompt', applyQuery(build.nodes, parseQuery('SYSTEM-PROMPT-INITIAL'), sessionEvents).rows.some(node => node.kind === 'system'))
check('full-text search reaches compaction summary', applyQuery(build.nodes, parseQuery('COMPACTION-SUMMARY'), sessionEvents).rows.some(node => node.kind === 'compaction'))
check('full-text search reaches folded burst members', applyQuery(build.nodes, parseQuery('BURST-OUTPUT-2'), sessionEvents).rows.some(node => node.burst !== undefined))

const wrapped = wrapInspectorLine(longOutput, 24)
check('long single-line output wraps onto multiple display rows', wrapped.length > 10, `${wrapped.length} rows`)
check('wrapped output preserves every character', wrapped.join('') === longOutput)
check('wrapped output keeps the tail reachable', wrapped.at(-1)?.endsWith('TAIL') === true, wrapped.at(-1))
check('every wrapped row respects terminal cell width', wrapped.every(line => stringWidth(line) <= 24))

const burst = build.nodes.find(node => node.burst !== undefined)
check('same-name calls still fold into a burst', burst?.burst?.members.length === 3)
if (burst?.burst !== undefined) {
  for (let index = 0; index < burst.burst.members.length; index++) {
    const member = burst.burst.members[index]!
    const detail = inspectNode(member, sessionEvents)
    const input = detail.tabs.find(tab => tab.id === 'input')?.sections.map(section => section.body).join('\n') ?? ''
    const output = detail.tabs.find(tab => tab.id === 'output')?.sections.map(section => section.body).join('\n') ?? ''
    check(`burst member ${index + 1} keeps its own input`, input.includes(`query-${index}`), input)
    check(`burst member ${index + 1} keeps its own output`, output.includes(`BURST-OUTPUT-${index}`), output)
  }
}

console.log(failed === 0 ? '\nAll trajectory detail checks passed.' : `\n${failed} trajectory detail check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
