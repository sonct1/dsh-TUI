import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface AutoContinueOptions {
  enabled?: boolean
  text?: string
  graceMs?: number
  cooldownMs?: number
  maxConsecutive?: number
  onMaxTokens?: boolean
}

export interface AutoContinueHooks {
  getAgent(): Agent
  pendingCount(): number
  isWorking(): boolean
  trackPending(message: { id: string; text: string }, placement: 'followup'): void
  untrackPending(messageId: string): void
  notify(key: AutoContinueNoticeKey, params?: Record<string, string | number>, options?: { color?: 'error' | 'warning' | 'success'; timeoutMs?: number }): void
  log(message: string): void
}

export type AutoContinueNoticeKey =
  | 'auto-continue-scheduled'
  | 'auto-continue-sent'
  | 'auto-continue-failed'
  | 'auto-continue-max-retries'
  | 'auto-continue-cooldown'
  | 'auto-continue-skip-permanent'

export interface AutoContinueScheduler {
  onLiveSessionEvent(event: SessionEvent): void
  resetForAgent(agent: Agent): void
  dispose(): void
}

type Trigger = 'transient-error' | 'max-tokens'

type Classification =
  | { action: 'schedule'; trigger: Trigger }
  | { action: 'reset' }
  | { action: 'skip'; reason: 'permanent' | 'ignored' }

const DEFAULT_TEXT = 'Tiếp tục một cách thận trọng. Chỉ tiếp tục phần việc đang làm dở đã được phê duyệt hoặc đã yêu cầu. Nếu tin nhắn trước đó của assistant là kế hoạch, đề xuất, câu hỏi, hoặc đang chờ người dùng phê duyệt, không triển khai; hãy nói rằng bạn đang chờ quyết định của người dùng.'
const DEFAULT_GRACE_MS = 3000
const DEFAULT_COOLDOWN_MS = 20_000
const DEFAULT_MAX_CONSECUTIVE = 3

export function createAutoContinueScheduler(
  options: AutoContinueOptions | undefined,
  hooks: AutoContinueHooks,
): AutoContinueScheduler {
  const enabled = options?.enabled === true
  const text = nonBlank(options?.text) ?? DEFAULT_TEXT
  const graceMs = nonNegative(options?.graceMs) ?? DEFAULT_GRACE_MS
  const cooldownMs = nonNegative(options?.cooldownMs) ?? DEFAULT_COOLDOWN_MS
  const maxConsecutive = Math.max(0, Math.floor(nonNegative(options?.maxConsecutive) ?? DEFAULT_MAX_CONSECUTIVE))
  const onMaxTokens = options?.onMaxTokens !== false

  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let consecutive = 0
  let lastSentAt = 0

  const clear = (): void => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const resetForAgent = (_agent: Agent): void => {
    generation += 1
    consecutive = 0
    lastSentAt = 0
    clear()
  }

  const schedule = (trigger: Trigger): void => {
    if (!enabled) return
    if (timer !== undefined) return
    if (hooks.pendingCount() > 0 || hooks.isWorking()) return
    if (consecutive >= maxConsecutive) {
      hooks.notify('auto-continue-max-retries', { max: maxConsecutive }, { color: 'warning', timeoutMs: 6000 })
      return
    }
    const now = Date.now()
    const remainingCooldown = Math.max(0, cooldownMs - (now - lastSentAt))
    if (remainingCooldown > 0) {
      hooks.notify('auto-continue-cooldown', { seconds: Math.ceil(remainingCooldown / 1000) }, { color: 'warning', timeoutMs: 5000 })
      return
    }

    const capturedAgent = hooks.getAgent()
    const capturedSession = capturedAgent.session
    const capturedGeneration = generation
    hooks.notify('auto-continue-scheduled', { seconds: Math.ceil(graceMs / 1000), reason: trigger }, { timeoutMs: Math.max(2000, graceMs) })
    timer = setTimeout(() => {
      timer = undefined
      if (capturedGeneration !== generation) return
      if (hooks.getAgent() !== capturedAgent) return
      if (capturedAgent.session !== capturedSession) return
      if (hooks.pendingCount() > 0 || hooks.isWorking()) return
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      hooks.trackPending({ id: message.id, text }, 'followup')
      try {
        capturedAgent.followup(message)
        consecutive += 1
        lastSentAt = Date.now()
        hooks.notify('auto-continue-sent', { count: consecutive, max: maxConsecutive }, { color: 'success', timeoutMs: 4000 })
      } catch (error) {
        hooks.untrackPending(message.id)
        const err = error instanceof Error ? error.message : String(error)
        hooks.log(`auto-continue: followup failed (${err})`)
        hooks.notify('auto-continue-failed', { err }, { color: 'error', timeoutMs: 8000 })
      }
    }, graceMs)
    timer.unref?.()
  }

  return {
    onLiveSessionEvent(event) {
      if (!enabled || event.type !== 'turn/end') return
      const classification = classifyTurnEnd(event, onMaxTokens)
      if (classification.action === 'reset') {
        consecutive = 0
        lastSentAt = 0
        clear()
        return
      }
      if (classification.action === 'skip') {
        clear()
        if (classification.reason === 'permanent') {
          hooks.notify('auto-continue-skip-permanent', undefined, { color: 'warning', timeoutMs: 6000 })
        }
        return
      }
      schedule(classification.trigger)
    },
    resetForAgent,
    dispose() {
      generation += 1
      consecutive = 0
      lastSentAt = 0
      clear()
    },
  }
}

function classifyTurnEnd(event: SessionEvent, onMaxTokens: boolean): Classification {
  const data = event.data as { reason?: unknown }
  const reason = data.reason
  if (!isRecord(reason)) return { action: 'skip', reason: 'ignored' }
  const kind = typeof reason.kind === 'string' ? reason.kind : ''
  if (kind === 'completed') return { action: 'reset' }
  if (kind === 'aborted' || kind === 'interrupted' || kind === 'blocked') return { action: 'skip', reason: 'ignored' }
  if (onMaxTokens && isMaxTokens(reason)) return { action: 'schedule', trigger: 'max-tokens' }
  if (kind === 'error') {
    const error = isRecord(reason.error) ? reason.error : reason
    if (isPermanent(error)) return { action: 'skip', reason: 'permanent' }
    if (isTransient(error)) return { action: 'schedule', trigger: 'transient-error' }
  }
  return { action: 'skip', reason: 'ignored' }
}

function isMaxTokens(reason: Record<string, unknown>): boolean {
  const values = [reason.kind, reason.code, reason.finishReason, reason.finish_reason, reason.stopReason, reason.stop_reason]
  if (isRecord(reason.error)) values.push(reason.error.code, reason.error.finishReason, reason.error.finish_reason)
  return values.some(value => typeof value === 'string' && /^(max[-_ ]?tokens|length|context[-_ ]?length)$/i.test(value))
}

function isTransient(error: Record<string, unknown>): boolean {
  if (error.transient === true || error.retryable === true || error.temporary === true) return true
  const status = numeric(error.status) ?? numeric(error.statusCode)
  if (status !== undefined && (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500)) return true
  const code = typeof error.code === 'string' ? error.code : ''
  if (/^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|RATE_LIMIT|TIMEOUT|SERVER|TRANSPORT|OVERLOADED|SERVICE_UNAVAILABLE)$/i.test(code)) return true
  const message = failureText(error)
  return /\b(timeout|timed out|network|connection reset|temporar(?:y|ily)|try again|rate limit|too many requests|overloaded|unavailable|bad gateway|gateway timeout)\b/i.test(message)
}

function isPermanent(error: Record<string, unknown>): boolean {
  if (error.permanent === true || error.fatal === true) return true
  const status = numeric(error.status) ?? numeric(error.statusCode)
  if (status !== undefined && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)) return true
  const code = typeof error.code === 'string' ? error.code : ''
  if (/^(AUTH|INVALID_CREDENTIAL|NO_ADAPTER|CONTEXT_WINDOW_EXCEEDED|QUOTA)$/i.test(code)) return true
  const text = failureText(error)
  return /\b(unauthorized|forbidden|api key|credential|quota|balance|billing|insufficient|unknown model|model not found|context length|maximum context|too many tokens)\b/i.test(text)
}

function failureText(error: Record<string, unknown>): string {
  const values = [error.code, error.message, error.type, error.name]
  return values.filter((value): value is string => typeof value === 'string').join(' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
