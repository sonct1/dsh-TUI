/**
 * Trajectory projection — folding the session event log into ledger nodes.
 *
 * ## What this is
 *
 * The DSH session log is an append-only stream of ~44 event types. This
 * module folds it into the flat, turn-annotated node list the trajectory
 * scene renders, pairing every bracket (`tool/call` ↔ `tool/result`,
 * `step/start` ↔ `step/end`, `llm/retry` ↔ `llm/retry-started`,
 * `approval/asked` ↔ `approval/decided`, `compaction/start` ↔
 * `compaction/end`, `tool/code-dispatch-start` ↔ `tool/code-dispatch`) so a
 * row can show its own wall-clock duration and outcome.
 *
 * ## Incrementality
 *
 * `agent.session.events` is an immutable snapshot whose element objects are
 * frozen at append and REUSED until the next append. {@link extendTrajectory}
 * exploits exactly that: when the incoming snapshot prefix-extends the one the
 * previous build consumed — proven by *object identity* at the previous last
 * index, never by `seq` arithmetic, which a fork can rewind — only the new
 * tail is folded. Any other relationship (agent swap on `/resume`, `/rewind`,
 * `/new`) rebuilds from scratch. A long session therefore never pays an O(n)
 * refold per frame, and `verify-trace-projection` asserts that the incremental
 * and from-scratch results are field-for-field identical at every split point.
 *
 * ## What it deliberately does not do
 *
 * No node holds derived text. `detail`/`outcome` are references into strings
 * the log already owns, and the view flattens only the rows it paints (see
 * {@link previewText}). Full content is not held at all — `seq`/`endSeq`
 * address the owning events for the inspector to re-read on demand.
 *
 * Storage-level chunk packing (`text-chunks`, `reasoning-chunks`,
 * `tool-call-chunks`) is a durable *encoding*, not an event vocabulary: the
 * persistence reader expands those rows back into `assistant/chunk` events
 * before they reach `Session.events`, so this fold only ever sees the
 * expanded form.
 */

import {
  asRawEvents,
  isApprovalDenied,
  readApprovalAsked,
  readApprovalDecided,
  readCommandRun,
  readCompaction,
  readDispatch,
  readHook,
  readModeValue,
  readRequestHeader,
  readRetry,
  readRetryStarted,
  readSubagent,
  readTodos,
  type RawTrajEvent,
} from './guards.js'
import { BURST_MIN, type TrajKind, type TrajNode, type TrajRequest, type TrajTokens } from './types.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Per-step streaming timestamps, the source of TTFT and decode duration. */
export interface StepTiming {
  /** `step/start` time. */
  readonly startTime: number
  /** First `assistant/chunk` time — the model's first observable output. */
  firstChunk?: number
  /** Last `assistant/chunk` time. */
  lastChunk?: number
  /** `step/end` time, when the step closed. */
  endTime?: number
}

/**
 * One assembled projection. Carries everything a continuation needs, so an
 * append folds only its tail; treat every field as owned by this module.
 */
export interface TrajBuild {
  /** The snapshot this build consumed; identity-compared on the next append. */
  readonly source: readonly RawTrajEvent[]
  /** The ledger, in log order, after burst folding. */
  readonly nodes: TrajNode[]
  /** Per-step timing keyed `${turn}:${step}`, for the hotspot aggregate. */
  readonly timing: Map<string, StepTiming>
  /**
   * Running counters, maintained O(1) per event.
   *
   * The status-line badge needs "how many rows, how many failed" on every
   * chat frame; deriving that with a scan would make an idle conversation pay
   * O(session) per repaint, which is exactly the cost the incremental fold
   * exists to avoid.
   */
  readonly counts: TrajCounts
  /** Open brackets and fold state; internal, but reused across appends. */
  readonly state: FoldState
}

/** Cheap session counters the chat chrome reads every frame. */
export interface TrajCounts {
  /** Ledger rows, after burst folding. */
  rows: number
  /** Rows that ended in failure, plus retry sequences. */
  errors: number
  /** Retry attempts across the session. */
  retries: number
}

/** Mutable fold bookkeeping carried between incremental appends. */
interface FoldState {
  counts: TrajCounts
  tools: Map<string, TrajNode>
  subtools: Map<string, TrajNode>
  steps: Map<string, TrajNode>
  turns: Map<number, TrajNode>
  retries: Map<string, TrajNode>
  approvals: Map<string, TrajNode>
  hooks: Map<string, TrajNode>
  /** Compaction brackets carry no observed id — a stack pairs them by nesting. */
  compactions: TrajNode[]
  /** Live turn context for events that carry none. */
  turn: number
  /** Live step context; cleared at `step/end`. */
  step: number | undefined
  /** True until the first `session/end-seed`; marks replayed history. */
  seeding: boolean
  /** `${kind}:${name}` of the run being folded, or undefined. */
  runKey: string | undefined
  /** Length of the current run. */
  runCount: number
  /** Index in `nodes` of the run's first row (or its burst stand-in). */
  runStart: number
  /** Members of the run, kept so the burst node can adopt them. */
  runMembers: TrajNode[]
  /** Previous request prompt snapshot, for detecting system/tool catalog changes. */
  requestPrompt: { readonly system: string; readonly toolsJson: string; readonly seq: number } | undefined
  /** Latest header supplies prompt/config and tool schemas to the next request. */
  requestHeader: { readonly seq: number; readonly provider?: string; readonly model?: string } | undefined
  /** Open request lifecycle rows keyed by request id, or the current step key. */
  requests: Map<string, TrajNode>
  /** Streaming assistant content retained until final message or interruption. */
  streams: Map<string, { text: string; reasoning: string; other: string[] }>
  /** Steps that produced a finalized assistant message. */
  assistantSteps: Set<string>
  /** User-message ids claimed by next-step steering inbox splices. */
  steeringIds: Set<string>
  /** Current next-step inbox ordering for splice bookkeeping. */
  nextStepInbox: string[]
}

/** Fresh, empty fold state. */
function newState(): FoldState {
  return {
    counts: { rows: 0, errors: 0, retries: 0 },
    tools: new Map(),
    subtools: new Map(),
    steps: new Map(),
    turns: new Map(),
    retries: new Map(),
    approvals: new Map(),
    hooks: new Map(),
    compactions: [],
    turn: 0,
    step: undefined,
    seeding: true,
    runKey: undefined,
    runCount: 0,
    runStart: -1,
    runMembers: [],
    requestPrompt: undefined,
    requestHeader: undefined,
    requests: new Map(),
    streams: new Map(),
    assistantSteps: new Set(),
    steeringIds: new Set(),
    nextStepInbox: [],
  }
}

/**
 * Clone the fold state for a continuation.
 *
 * The bracket maps are copied so a continuation does not mutate its input's
 * bookkeeping — but `runMembers` is deliberately SHARED, not copied: once a
 * run reaches {@link BURST_MIN} the synthetic burst node holds that very
 * array, and a run that spans an incremental boundary must keep growing the
 * array the node already references. Copying it here would silently freeze
 * every burst at the length it had when the append arrived.
 *
 * Like the node list itself, a build is consumed once — extending the same
 * `previous` twice with different tails is not supported (and matches the
 * pre-existing trace fold's contract).
 */
function cloneState(previous: FoldState): FoldState {
  return {
    // Counters are shared, not copied: like `nodes`, they belong to the build
    // being extended, and a continuation must keep incrementing the same
    // object the caller already holds.
    counts: previous.counts,
    tools: new Map(previous.tools),
    subtools: new Map(previous.subtools),
    steps: new Map(previous.steps),
    turns: new Map(previous.turns),
    retries: new Map(previous.retries),
    approvals: new Map(previous.approvals),
    hooks: new Map(previous.hooks),
    compactions: [...previous.compactions],
    turn: previous.turn,
    step: previous.step,
    seeding: previous.seeding,
    runKey: previous.runKey,
    runCount: previous.runCount,
    runStart: previous.runStart,
    runMembers: previous.runMembers,
    requestPrompt: previous.requestPrompt,
    requestHeader: previous.requestHeader,
    requests: new Map(previous.requests),
    streams: new Map([...previous.streams].map(([key, value]) => [key, { text: value.text, reasoning: value.reasoning, other: [...value.other] }])),
    assistantSteps: new Set(previous.assistantSteps),
    steeringIds: new Set(previous.steeringIds),
    nextStepInbox: [...previous.nextStepInbox],
  }
}

/** Read the first text block, including nested tool-result content arrays. */
function firstText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    const nested = firstText(record.content)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** Accumulate streamed assistant content without emitting one row per delta. */
function updateStream(
  stream: { text: string; reasoning: string; other: string[] },
  chunk: unknown,
): void {
  if (typeof chunk === 'string') {
    stream.text += chunk
    return
  }
  if (typeof chunk !== 'object' || chunk === null) return
  const record = chunk as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : 'unknown'
  const text = typeof record.text === 'string'
    ? record.text
    : typeof record.argumentsDelta === 'string'
      ? record.argumentsDelta
      : ''
  if (type.includes('reasoning')) {
    stream.reasoning += text
    return
  }
  if (type.includes('text') || type === 'delta') {
    stream.text += text
    return
  }
  if (type === 'block-end' && typeof record.block === 'object' && record.block !== null) {
    const block = record.block as Record<string, unknown>
    if (block.type === 'reasoning' && typeof block.text === 'string') stream.reasoning += block.text
    else if (block.type === 'text' && typeof block.text === 'string') stream.text += block.text
    else stream.other.push(`[${String(block.type ?? 'block')}]`)
    return
  }
  if (type === 'usage' || type === 'finish' || type === 'block-start') return
  const name = typeof record.name === 'string' ? ` ${record.name}` : ''
  const id = typeof record.id === 'string' ? ` ${record.id}` : ''
  stream.other.push(`[${type}${name}${id}${text === '' ? '' : ` ${text}`}]`)
}

/** Whether a streamed chunk carries the model's first observable token. */
function isTokenChunk(chunk: unknown): boolean {
  if (typeof chunk === 'string') return chunk !== ''
  if (typeof chunk !== 'object' || chunk === null) return false
  const record = chunk as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (type === 'text-delta' || type === 'reasoning-delta' || type === 'tool-call-delta' || type === 'delta') return true
  if (type === 'block-end' && typeof record.block === 'object' && record.block !== null) {
    const block = record.block as Record<string, unknown>
    return typeof block.text === 'string' && block.text !== ''
  }
  return false
}

/** Whether an official nested tool-result block marks the call as failed. */
function resultIsError(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.isError === true || resultIsError(record.content)) return true
  }
  return false
}

/** Read token accounting off an `assistant/message` payload. */
function readTokens(usage: unknown): TrajTokens | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const record = usage as Record<string, unknown>
  const pick = (key: string): number => {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  const tokens: TrajTokens = {
    // Real provider usage uses *Tokens; older adapters emitted short aliases.
    input: pick('inputTokens') || pick('input'),
    output: pick('outputTokens') || pick('output'),
    think: pick('reasoningTokens') || pick('think') || pick('reasoning'),
    cacheRead: pick('cacheReadTokens') || pick('cacheRead'),
    cacheWrite: pick('cacheWriteTokens') || pick('cacheWrite'),
  }
  const total =
    tokens.input + tokens.output + tokens.think + tokens.cacheRead + tokens.cacheWrite
  return total > 0 ? tokens : undefined
}

/** Close a bracket node with its own duration and outcome. */
function requestKey(data: Record<string, unknown> | undefined, turn: number, step: number | undefined): string {
  const id = data?.requestId ?? data?.id
  return typeof id === 'string' ? id : `${turn}:${step ?? 0}`
}

function requestFor(state: FoldState, data: Record<string, unknown> | undefined, turn: number, step: number | undefined): TrajNode | undefined {
  return state.requests.get(requestKey(data, turn, step)) ?? state.requests.get(`${turn}:${step ?? 0}`)
}

function close(
  state: FoldState,
  node: TrajNode | undefined,
  event: RawTrajEvent,
  status: TrajNode['status'],
  errorCode?: string,
): void {
  if (node === undefined) return
  if (status === 'error' && node.status !== 'error') state.counts.errors += 1
  node.endSeq = event.seq
  node.durationMs = Math.max(0, event.time - node.time)
  node.status = status
  if (errorCode !== undefined) node.errorCode = errorCode
}

/**
 * Append a node, folding runs of >= {@link BURST_MIN} consecutive same-name
 * tool/subtool calls into one synthetic burst row.
 *
 * The run's members stay live: the pairing maps still hold the very objects
 * `close(state, )` mutates when their results land, and the burst reads its totals
 * off them on demand. Nothing needs re-visiting when a folded member closes.
 */
function push(state: FoldState, nodes: TrajNode[], node: TrajNode): void {
  const foldable = node.kind === 'tool' || node.kind === 'subtool'
  const key = foldable ? `${node.kind}:${node.label}` : undefined

  if (key !== undefined && key === state.runKey) {
    state.runCount += 1
    state.runMembers.push(node)
    if (state.runCount < BURST_MIN) {
      // Below the fold threshold the run is still shown call by call; the
      // rows only merge once the run proves long enough to be noise.
      nodes.push(node)
      return
    }
    if (state.runCount === BURST_MIN) {
      // Replace the run's rows with one synthetic burst node. The head's
      // position is reused so surrounding order is untouched; rows after it
      // cannot exist, because a run is by definition the ledger's tail.
      const head = state.runMembers[0]!
      nodes.length = state.runStart
      nodes.push({
        seq: head.seq,
        time: head.time,
        kind: head.kind,
        turn: head.turn,
        step: head.step,
        label: head.label,
        callId: head.callId,
        subCallId: head.subCallId,
        seed: head.seed,
        burst: { name: head.label, members: state.runMembers },
      })
    }
    // Beyond BURST_MIN the burst node already references `runMembers`, which
    // was appended to above — nothing further to do.
    return
  }

  state.runKey = key
  state.runCount = key === undefined ? 0 : 1
  state.runStart = nodes.length
  state.runMembers = key === undefined ? [] : [node]
  nodes.push(node)
}

/** Row count after burst folding — the ledger's own length. */
function syncRowCount(state: FoldState, nodes: TrajNode[]): void {
  state.counts.rows = nodes.length
}

/** Fold one event into the working build. */
function consume(state: FoldState, nodes: TrajNode[], timing: Map<string, StepTiming>, event: RawTrajEvent): void {
  const data = event.data as Record<string, unknown> | undefined
  const base = { seq: event.seq, time: event.time, seed: state.seeding || undefined }

  switch (event.type) {
    case 'session/end-seed': {
      // Everything folded so far came from a replayed seed. Re-mark rather
      // than trusting the first occurrence: a re-seeded log carries more than
      // one, and only the LAST one bounds the inherited history.
      for (const node of nodes) node.seed = true
      state.seeding = false
      return
    }

    case 'turn/start': {
      const turn = typeof data?.turn === 'number' ? data.turn : state.turn + 1
      state.turn = turn
      state.step = undefined
      const node: TrajNode = { ...base, kind: 'turn', turn, label: `turn ${turn}`, status: 'running' }
      state.turns.set(turn, node)
      push(state, nodes, node)
      return
    }

    case 'turn/end': {
      const turn = typeof data?.turn === 'number' ? data.turn : state.turn
      const open = state.turns.get(turn)
      const reason = data?.reason
      const kind =
        typeof reason === 'object' && reason !== null
          ? (reason as Record<string, unknown>).kind
          : undefined
      const turnStatus = kind === 'completed' ? 'ok' : 'error'
      const turnError = typeof kind === 'string' && kind !== 'completed' ? kind : undefined
      close(state, open, event, turnStatus, turnError)
      state.turns.delete(turn)
      const closedRequests = new Set<TrajNode>()
      for (const [key, request] of [...state.requests]) {
        if (request.turn !== turn || closedRequests.has(request)) continue
        closedRequests.add(request)
        const stepKey = `${request.turn}:${request.step ?? 0}`
        if (state.assistantSteps.has(stepKey)) {
          state.requests.delete(key)
          continue
        }
        const stream = state.streams.get(stepKey)
        if (stream !== undefined) {
          if (stream.reasoning.trim() !== '') {
            push(state, nodes, { ...base, kind: 'thinking', turn, step: request.step, label: 'interrupted', detail: stream.reasoning, status: 'error' })
          }
          const output = [stream.text, ...stream.other].filter(value => value.trim() !== '').join('\n')
          if (output !== '') {
            push(state, nodes, { ...base, kind: 'assistant', turn, step: request.step, label: 'interrupted', detail: output, status: 'error' })
          }
        }
        request.request ??= {}
        request.request.completionTime ??= event.time
        close(state, request, event, turnStatus, turnError)
        push(state, nodes, request)
        state.requests.delete(key)
      }
      for (const key of [...state.streams.keys()]) if (key.startsWith(`${turn}:`)) state.streams.delete(key)
      for (const key of [...state.assistantSteps]) if (key.startsWith(`${turn}:`)) state.assistantSteps.delete(key)
      state.step = undefined
      return
    }

    case 'step/start': {
      const turn = typeof data?.turn === 'number' ? data.turn : state.turn
      const step = typeof data?.step === 'number' ? data.step : 0
      state.turn = turn
      state.step = step
      timing.set(`${turn}:${step}`, { startTime: event.time })
      const node: TrajNode = { ...base, kind: 'step', turn, step, label: `step ${step}`, status: 'running' }
      state.steps.set(`${turn}:${step}`, node)
      push(state, nodes, node)
      // A step is a request even when it is interrupted before assistant/message.
      const header = state.requestHeader
      const request: TrajRequest = {
        provider: header?.provider,
        model: header?.model,
        promptSeq: state.requestPrompt?.seq,
        configSeq: header?.seq,
        headerSeq: header?.seq,
      }
      const requestNode: TrajNode = { ...base, kind: 'request', turn, step, label: header?.model ?? 'request', status: 'running', request }
      state.requests.set(`${turn}:${step}`, requestNode)
      state.streams.set(`${turn}:${step}`, { text: '', reasoning: '', other: [] })
      return
    }

    case 'step/end': {
      const turn = typeof data?.turn === 'number' ? data.turn : state.turn
      const step = typeof data?.step === 'number' ? data.step : (state.step ?? 0)
      const key = `${turn}:${step}`
      close(state, state.steps.get(key), event, 'ok')
      state.steps.delete(key)
      const slot = timing.get(key)
      if (slot !== undefined) slot.endTime = event.time
      const request = state.requests.get(key)
      if (request !== undefined) {
        request.request ??= {}
        request.request.completionTime ??= event.time
        const stream = state.streams.get(key)
        const hasAssistant = state.assistantSteps.has(key)
        if (!hasAssistant && stream !== undefined) {
          if (stream.reasoning.trim() !== '') {
            push(state, nodes, { ...base, kind: 'thinking', turn, step, label: 'interrupted', detail: stream.reasoning, status: 'error' })
          }
          const output = [stream.text, ...stream.other].filter(value => value.trim() !== '').join('\n')
          if (output !== '') {
            push(state, nodes, { ...base, kind: 'assistant', turn, step, label: 'interrupted', detail: output, status: 'error' })
          }
          close(state, request, event, 'error', 'interrupted')
          push(state, nodes, request)
        }
        state.requests.delete(key)
        state.streams.delete(key)
      }
      state.streams.delete(key)
      state.assistantSteps.delete(key)
      state.step = undefined
      return
    }

    case 'request/start':
    case 'request/running': {
      const turn = typeof data?.turn === 'number' ? data.turn : state.turn
      const step = typeof data?.step === 'number' ? data.step : state.step
      const key = requestKey(data, turn, step)
      let request = state.requests.get(key) ?? state.requests.get(`${turn}:${step ?? 0}`)
      if (request === undefined) {
        const header = state.requestHeader
        request = {
          ...base,
          kind: 'request',
          turn,
          step,
          label: header?.model ?? 'request',
          status: 'running',
          request: {
            id: typeof data?.requestId === 'string' ? data.requestId : typeof data?.id === 'string' ? data.id : undefined,
            provider: header?.provider,
            model: header?.model,
            promptSeq: state.requestPrompt?.seq,
            configSeq: header?.seq,
            headerSeq: header?.seq,
          },
        }
      }
      state.requests.set(key, request)
      state.requests.set(`${turn}:${step ?? 0}`, request)
      return
    }

    case 'request/complete':
    case 'request/error': {
      const turn = typeof data?.turn === 'number' ? data.turn : state.turn
      const step = typeof data?.step === 'number' ? data.step : state.step
      const request = requestFor(state, data, turn, step)
      if (request !== undefined) {
        const tokens = readTokens(data?.usage)
        request.request ??= {}
        request.request.usage = tokens
        request.request.completionTime = event.time
        const error = data?.error
        const code = typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>).code === 'string'
          ? (error as Record<string, unknown>).code as string
          : undefined
        close(state, request, event, event.type === 'request/error' ? 'error' : 'ok', code)
        const stepKey = `${turn}:${step ?? 0}`
        if (!state.assistantSteps.has(stepKey)) {
          const stream = state.streams.get(stepKey)
          if (stream !== undefined) {
            if (stream.reasoning.trim() !== '') {
              push(state, nodes, { ...base, kind: 'thinking', turn, step, label: 'interrupted', detail: stream.reasoning, status: 'error' })
            }
            const output = [stream.text, ...stream.other].filter(value => value.trim() !== '').join('\n')
            if (output !== '') {
              push(state, nodes, { ...base, kind: 'assistant', turn, step, label: 'interrupted', detail: output, status: 'error' })
            }
          }
          push(state, nodes, request)
        }
        state.requests.delete(requestKey(data, turn, step))
        state.requests.delete(`${turn}:${step ?? 0}`)
        state.streams.delete(`${turn}:${step ?? 0}`)
        state.assistantSteps.delete(`${turn}:${step ?? 0}`)
      }
      return
    }

    case 'assistant/chunk': {
      // Chunks never become rows; they contribute only the two timestamps
      // that separate time-to-first-token from decode throughput.
      const turn = typeof data?.turn === 'number' ? data.turn : state.turn
      const step = typeof data?.step === 'number' ? data.step : (state.step ?? 0)
      const slot = timing.get(`${turn}:${step}`)
      if (slot === undefined) return
      const tokenChunk = isTokenChunk(data?.chunk)
      if (tokenChunk) {
        slot.firstChunk ??= event.time
        slot.lastChunk = event.time
      }
      const request = requestFor(state, data, turn, step)
      if (request !== undefined && tokenChunk) {
        request.request ??= {}
        request.request.firstTokenTime ??= event.time
      }
      const stream = state.streams.get(`${turn}:${step}`) ?? { text: '', reasoning: '', other: [] }
      updateStream(stream, data?.chunk)
      state.streams.set(`${turn}:${step}`, stream)
      const chunk = data?.chunk
      if (typeof chunk === 'object' && chunk !== null && (chunk as Record<string, unknown>).type === 'usage') {
        const usage = readTokens((chunk as Record<string, unknown>).usage)
        if (request !== undefined && usage !== undefined) {
          request.request ??= {}
          request.request.usage = usage
        }
      }
      return
    }

    case 'agent/inbox/spliced': {
      if (data?.target !== 'next-step') return
      const start = typeof data.start === 'number' ? Math.max(0, data.start) : 0
      const removedCount = typeof data.removedCount === 'number' ? Math.max(0, data.removedCount) : 0
      const inserted = Array.isArray(data.inserted)
        ? data.inserted.flatMap(item => {
            if (typeof item === 'string') return [item]
            if (typeof item !== 'object' || item === null) return []
            const id = (item as Record<string, unknown>).id
            return typeof id === 'string' ? [id] : []
          })
        : []
      const removed = state.nextStepInbox.splice(start, removedCount, ...inserted)
      for (const id of inserted) state.steeringIds.delete(id)
      if (data.outcome !== 'canceled') for (const id of removed) state.steeringIds.add(id)
      return
    }

    case 'user/message': {
      const source = data?.source
      const sourceKind =
        typeof source === 'object' && source !== null
          ? (source as Record<string, unknown>).kind
          : undefined
      const text = firstText(data?.content)
      if (text === undefined || text.trim() === '') return
      // A direct human prompt is a USER row; everything else on the user-role
      // surface (skill bodies, file-change notices, goal continuations) is an
      // injected CONTEXT row — same distinction the official ledger draws.
      const messageId = typeof data?.id === 'string' ? data.id : undefined
      const steering = messageId !== undefined && state.steeringIds.has(messageId)
      const isHuman = sourceKind === 'user'
      const sourceName =
        typeof source === 'object' && source !== null
          ? ((source as Record<string, unknown>).name as string | undefined)
          : undefined
      push(state, nodes, {
        ...base,
        kind: isHuman ? 'user' : 'context',
        turn: state.turn,
        step: state.step,
        label: steering ? 'steering' : isHuman ? '' : (sourceName ?? (typeof sourceKind === 'string' ? sourceKind : 'context')),
        detail: text,
      })
      return
    }

    case 'assistant/message': {
      const turn = typeof data?.turn === 'number' ? data.turn : state.turn
      const step = typeof data?.step === 'number' ? data.step : state.step
      const message = data?.message
      const content =
        typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>).content
          : undefined
      const tokens = readTokens(data?.usage)
      const stepKey = `${turn}:${step ?? 0}`
      state.assistantSteps.add(stepKey)
      state.streams.delete(stepKey)
      const request = requestFor(state, data, turn, step)
      if (request !== undefined) {
        request.request ??= {}
        request.request.usage = tokens
        request.request.completionTime ??= event.time
        close(state, request, event, 'ok')
        state.requests.delete(requestKey(data, turn, step))
        state.requests.delete(`${turn}:${step ?? 0}`)
      }
      let first = true
      let emitted = false
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue
          const record = block as Record<string, unknown>
          const text = typeof record.text === 'string' ? record.text : ''
          if (text.trim() === '') continue
          const kind: TrajKind = record.type === 'reasoning' ? 'thinking' : record.type === 'text' ? 'assistant' : 'assistant'
          if (record.type !== 'reasoning' && record.type !== 'text') continue
          push(state, nodes, {
            ...base,
            kind,
            turn,
            step,
            label: '',
            detail: text,
            // Usage belongs to the step, not to each block: attach it to the
            // first row so the hotspot aggregate counts it exactly once.
            tokens: first ? tokens : undefined,
            request: first ? request?.request : undefined,
          })
          emitted = true
          first = false
        }
      }
      if (!emitted && Array.isArray(content) && content.some(block =>
        typeof block === 'object' && block !== null &&
        ['tool_use', 'tool-call', 'tool_call'].includes(String((block as Record<string, unknown>).type)),
      )) {
        push(state, nodes, {
          ...base,
          kind: 'assistant',
          turn,
          step,
          label: 'tool call only',
          detail: 'Tool call only',
          tokens,
          request: request?.request,
        })
      }
      return
    }

    case 'tool/call': {
      const callId = typeof data?.callId === 'string' ? data.callId : undefined
      const name = typeof data?.name === 'string' ? data.name : 'tool'
      const args = typeof data?.arguments === 'string' ? data.arguments : undefined
      const ownerRequest = requestFor(
        state,
        data,
        typeof data?.turn === 'number' ? data.turn : state.turn,
        typeof data?.step === 'number' ? data.step : state.step,
      )?.request ?? (state.requestHeader === undefined ? undefined : {
        provider: state.requestHeader.provider,
        model: state.requestHeader.model,
        promptSeq: state.requestPrompt?.seq,
        configSeq: state.requestHeader.seq,
        headerSeq: state.requestHeader.seq,
      })
      const node: TrajNode = {
        ...base,
        kind: 'tool',
        turn: typeof data?.turn === 'number' ? data.turn : state.turn,
        step: typeof data?.step === 'number' ? data.step : state.step,
        label: name,
        detail: args,
        callId,
        parentCallId: typeof data?.parentCallId === 'string' ? data.parentCallId : undefined,
        rootCallId: typeof data?.rootCallId === 'string' ? data.rootCallId : callId,
        depth: typeof data?.depth === 'number' ? data.depth : 0,
        request: ownerRequest,
        status: 'running',
      }
      if (callId !== undefined) state.tools.set(callId, node)
      push(state, nodes, node)
      return
    }

    case 'tool/result': {
      const message = data?.message
      const source =
        typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>).source
          : undefined
      const callId =
        typeof source === 'object' && source !== null
          ? ((source as Record<string, unknown>).callId as string | undefined)
          : undefined
      if (callId === undefined) return
      const open = state.tools.get(callId)
      if (open === undefined) return
      const error = data?.error
      const code =
        typeof error === 'object' && error !== null
          ? ((error as Record<string, unknown>).code as string | undefined)
          : undefined
      const content =
        typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>).content
          : undefined
      open.outcome = firstText(content)
      close(state, open, event, error === undefined && !resultIsError(content) ? 'ok' : 'error', code)
      state.tools.delete(callId)
      return
    }

    case 'tool/code-dispatch-start': {
      const payload = readDispatch(event.data)
      if (payload === undefined) return
      const ownerRequest = requestFor(state, data, state.turn, state.step)?.request ?? (state.requestHeader === undefined ? undefined : {
        provider: state.requestHeader.provider,
        model: state.requestHeader.model,
        promptSeq: state.requestPrompt?.seq,
        configSeq: state.requestHeader.seq,
        headerSeq: state.requestHeader.seq,
      })
      const parent = payload.parentCallId === undefined
        ? undefined
        : state.subtools.get(payload.parentCallId) ?? state.tools.get(payload.parentCallId)
      const node: TrajNode = {
        ...base,
        kind: 'subtool',
        turn: state.turn,
        step: state.step,
        label: payload.name,
        detail: payload.args,
        callId: payload.rootCallId,
        subCallId: payload.subCallId,
        parentCallId: payload.parentCallId,
        rootCallId: payload.rootCallId,
        depth: (parent?.depth ?? 0) + 1,
        request: ownerRequest,
        status: 'running',
      }
      state.subtools.set(payload.subCallId, node)
      push(state, nodes, node)
      return
    }

    case 'tool/code-dispatch': {
      const payload = readDispatch(event.data)
      if (payload === undefined) return
      const open = state.subtools.get(payload.subCallId)
      if (open === undefined) return
      close(state, open, event, payload.isError === true ? 'error' : 'ok')
      state.subtools.delete(payload.subCallId)
      return
    }

    case 'llm/retry': {
      const payload = readRetry(event.data)
      if (payload === undefined) return
      const existing = state.retries.get(payload.retryId)
      if (existing !== undefined) {
        // Same retry sequence, next attempt: keep one row and accumulate.
        existing.attempts = (existing.attempts ?? 1) + 1
        existing.durationMs = (existing.durationMs ?? 0) + payload.delayMs
        state.counts.retries += 1
        return
      }
      const node: TrajNode = {
        ...base,
        kind: 'retry',
        turn: payload.turn ?? state.turn,
        step: payload.step ?? state.step,
        label: payload.code ?? 'retry',
        detail: payload.message,
        status: 'running',
        errorCode: payload.code,
        attempts: 1,
        durationMs: payload.delayMs,
      }
      state.retries.set(payload.retryId, node)
      state.counts.retries += 1
      state.counts.errors += 1
      push(state, nodes, node)
      return
    }

    case 'llm/retry-started': {
      const retryId = readRetryStarted(event.data)
      if (retryId === undefined) return
      const open = state.retries.get(retryId)
      if (open === undefined) return
      // The bracket closes when the retried request starts; the accumulated
      // backoff is the row's own duration, so `close(state, )` must not overwrite it.
      open.endSeq = event.seq
      open.status = 'ok'
      state.retries.delete(retryId)
      return
    }

    case 'approval/asked': {
      const payload = readApprovalAsked(event.data)
      if (payload === undefined) return
      const node: TrajNode = {
        ...base,
        kind: 'approval',
        turn: state.turn,
        step: state.step,
        label: payload.toolName ?? 'approval',
        detail: payload.reason,
        callId: payload.callId,
        status: 'running',
      }
      state.approvals.set(payload.id, node)
      push(state, nodes, node)
      return
    }

    case 'approval/decided': {
      const payload = readApprovalDecided(event.data)
      if (payload === undefined) return
      const open = state.approvals.get(payload.id)
      if (open === undefined) return
      open.outcome = payload.outcome
      close(state, open, event, isApprovalDenied(payload.outcome) ? 'error' : 'ok')
      state.approvals.delete(payload.id)
      return
    }

    case 'hook/invoked': {
      const payload = readHook(event.data)
      if (payload === undefined) return
      const node: TrajNode = {
        ...base,
        kind: 'system',
        turn: state.turn,
        step: state.step,
        label: `hook ${payload.name}`,
        detail: payload.event,
        status: 'running',
      }
      if (payload.id !== undefined) state.hooks.set(payload.id, node)
      push(state, nodes, node)
      return
    }

    case 'hook/result': {
      const payload = readHook(event.data)
      const open = payload?.id === undefined ? undefined : state.hooks.get(payload.id)
      if (open === undefined) return
      close(state, open, event, 'ok')
      state.hooks.delete(payload!.id!)
      return
    }

    case 'compaction/start': {
      const payload = readCompaction(event.data)
      const node: TrajNode = {
        ...base,
        kind: 'compaction',
        turn: state.turn,
        step: state.step,
        label: 'compaction',
        detail: payload.reason,
        status: 'running',
      }
      state.compactions.push(node)
      push(state, nodes, node)
      return
    }

    case 'compaction/summary':
    case 'compaction/checkpoint': {
      const payload = readCompaction(event.data)
      const open = state.compactions.at(-1)
      if (open !== undefined) {
        open.outcome = payload.summary ?? payload.output ?? open.outcome
        open.request = { provider: payload.provider, model: payload.model, usage: readTokens(payload.usage) }
      }
      return
    }

    case 'compaction/error': {
      const open = state.compactions.pop()
      const payload = readCompaction(event.data)
      if (open !== undefined) {
        open.outcome = payload.summary ?? payload.output ?? payload.error
        open.request = { provider: payload.provider, model: payload.model, usage: readTokens(payload.usage) }
      }
      close(state, open, event, 'error', payload.error)
      return
    }

    case 'compaction/end': {
      const open = state.compactions.pop()
      const payload = readCompaction(event.data)
      if (open !== undefined) {
        open.outcome = payload.summary ?? payload.output ?? open.outcome ?? (payload.removed === undefined ? undefined : `-${payload.removed}`)
        open.request = {
          ...open.request,
          provider: payload.provider ?? open.request?.provider,
          model: payload.model ?? open.request?.model,
          usage: readTokens(payload.usage) ?? open.request?.usage,
        }
      }
      close(state, open, event, 'ok')
      return
    }

    case 'request/header': {
      const payload = readRequestHeader(event.data)
      if (payload === undefined) return
      const toolsJson = JSON.stringify(payload.tools)
      const previous = state.requestPrompt
      const initial = previous === undefined && (payload.reason === 'initial' || payload.reason === undefined)
      const systemChanged = previous !== undefined && previous.system !== payload.system
      const toolsChanged = previous !== undefined && previous.toolsJson !== toolsJson
      state.requestPrompt = { system: payload.system, toolsJson, seq: event.seq }
      state.requestHeader = { seq: event.seq, provider: payload.provider, model: payload.model }
      if (!initial && !systemChanged && !toolsChanged) return
      const label = initial
        ? 'initial prompt'
        : systemChanged && toolsChanged
          ? 'system + tools changed'
          : systemChanged
            ? 'system prompt changed'
            : 'tools changed'
      push(state, nodes, {
        ...base,
        kind: 'system',
        turn: state.turn,
        step: state.step,
        label,
        detail: [payload.model, payload.effort === undefined ? undefined : `effort=${payload.effort}`]
          .filter((value): value is string => value !== undefined)
          .join(' · ') || undefined,
      })
      return
    }

    case 'subagent/descriptor': {
      const payload = readSubagent(event.data)
      if (payload === undefined) return
      push(state, nodes, {
        ...base,
        kind: 'context',
        turn: state.turn,
        step: state.step,
        label: 'subagent',
        detail: [payload.label, payload.model].filter(Boolean).join(' · ') || undefined,
      })
      return
    }

    case 'sandbox/mode':
    case 'plan/mode':
    case 'approval/policy':
    case 'permission/preset':
    case 'agent-preset/selected': {
      const value = readModeValue(event.data)
      if (value === undefined) return
      push(state, nodes, {
        ...base,
        kind: 'system',
        turn: state.turn,
        step: state.step,
        label: event.type.split('/')[1] ?? event.type,
        detail: value,
      })
      return
    }

    case 'command/run': {
      const payload = readCommandRun(event.data)
      if (payload === undefined) return
      push(state, nodes, {
        ...base,
        kind: 'system',
        turn: state.turn,
        step: state.step,
        label: `/${payload.name}`,
        detail: payload.args?.trim() === '' ? undefined : payload.args,
      })
      return
    }

    case 'todo/write': {
      const payload = readTodos(event.data)
      if (payload === undefined) return
      push(state, nodes, {
        ...base,
        kind: 'todo',
        turn: state.turn,
        step: state.step,
        label: `${payload.done}/${payload.total}`,
        detail: payload.current,
      })
      return
    }

    default:
      // Unknown or deliberately silent (request/context, session/title,
      // agent/inbox/spliced, command/done, …): no ledger row. Forward
      // compatibility is the default, not an error path.
      return
  }
}

/** An empty build, used as the identity element and for empty sessions. */
export function emptyTrajectory(): TrajBuild {
  const state = newState()
  return { source: [], nodes: [], timing: new Map(), counts: state.counts, state }
}

/**
 * Extend a previous projection with the session's current event snapshot.
 *
 * @param previous - The prior build, or `null` to fold from scratch.
 * @param events - The session's current immutable event snapshot.
 * @returns A build over `events`; `previous` itself when nothing was appended.
 */
export function extendTrajectory(
  previous: TrajBuild | null,
  events: readonly SessionEvent[],
): TrajBuild {
  const raw = asRawEvents(events)
  if (
    previous !== null &&
    raw.length >= previous.source.length &&
    (previous.source.length === 0 ||
      raw[previous.source.length - 1] === previous.source[previous.source.length - 1])
  ) {
    if (raw.length === previous.source.length) return previous
    const nodes = previous.nodes
    const timing = previous.timing
    const state = cloneState(previous.state)
    for (let index = previous.source.length; index < raw.length; index++) {
      consume(state, nodes, timing, raw[index]!)
    }
    syncRowCount(state, nodes)
    return { source: raw, nodes, timing, counts: state.counts, state }
  }
  const nodes: TrajNode[] = []
  const timing = new Map<string, StepTiming>()
  const state = newState()
  for (const event of raw) consume(state, nodes, timing, event)
  syncRowCount(state, nodes)
  return { source: raw, nodes, timing, counts: state.counts, state }
}

/**
 * Fold from scratch — the one-shot form used by tests and by consumers that
 * hold no previous build.
 */
export function buildTrajectory(events: readonly SessionEvent[]): TrajBuild {
  return extendTrajectory(null, events)
}
