import type { ActivityState } from 'dsh-working-activity/status'
import type { Lang } from '../i18n.js'

/** Translate the functional copy emitted by the non-playful activity tracker. */
export function localizeActivityState(state: ActivityState, lang: Lang): ActivityState {
  if (lang !== 'en' || state.line === '') return state

  const cjkNarration = state.phrase !== undefined && /[\u3400-\u9fff]/u.test(state.phrase)
  const narrationPrefix = cjkNarration ? `⏵ ${state.phrase} · ` : undefined
  let line = narrationPrefix !== undefined && state.line.startsWith(narrationPrefix)
    ? state.line.slice(narrationPrefix.length)
    : state.line

  if (state.phase === 'waiting') {
    line = line.replace(/^等待模型响应 · 总/u, 'Waiting for model · total ')
  } else if (state.phase === 'thinking') {
    line = line
      .replace(/^思考中 · 总/u, 'Thinking · total ')
      .replace(/^总/u, 'Thinking · total ')
      .replace(/^(⏵ .+) · 总/u, '$1 · total ')
  } else if (state.phase === 'done') {
    line = line.replace(
      /^搞定 ✓ · (\d+) 工具 · 想([^ ]+) 干([^ ·]+)(.*)$/u,
      (_match, count: string, thinking: string, working: string, suffix: string) =>
        `Done ✓ · ${count} ${count === '1' ? 'tool' : 'tools'} · thought ${thinking} · worked ${working}${suffix}`,
    )
    line = line.replace(
      /^搞定 ✓ · (.+) · (\d+) 工具(.*)$/u,
      (_match, fragment: string, count: string, suffix: string) =>
        `Done ✓ · ${fragment} · ${count} ${count === '1' ? 'tool' : 'tools'}${suffix}`,
    )
  }

  if (line === state.line) return state
  const label = state.phase === 'waiting'
    ? 'Waiting for model'
    : state.phase === 'thinking'
      ? 'Thinking'
      : state.label
  if (cjkNarration) {
    const { phrase: _phrase, ...withoutPhrase } = state
    return { ...withoutPhrase, line, ...(label === undefined ? {} : { label }) }
  }
  return { ...state, line, ...(label === undefined ? {} : { label }) }
}
