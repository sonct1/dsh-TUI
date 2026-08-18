import assert from 'node:assert/strict'
import { localizeActivityState } from '../lib/types/dsh-adapter/activity-localization.js'

const base = {
  toolCount: 0,
  turnElapsedMs: 21_000,
  phaseStartedAt: 0,
}

const cases = [
  [{ ...base, phase: 'waiting', line: '等待模型响应 · 总21s', label: '等待模型响应' }, 'Waiting for model · total 21s'],
  [{ ...base, phase: 'thinking', line: '思考中 · 总21s', label: '思考中' }, 'Thinking · total 21s'],
  [{ ...base, phase: 'thinking', line: '⏵ Truy chuỗi tiếng Trung ở status line · 总21s', phrase: 'Truy chuỗi tiếng Trung ở status line' }, '⏵ Truy chuỗi tiếng Trung ở status line · total 21s'],
  [{ ...base, phase: 'thinking', line: '⏵ 看下仓库结构和说明文档This is a TypeScript/Node pro · 总7s', phrase: '看下仓库结构和说明文档This is a TypeScript/Node pro' }, 'Thinking · total 7s'],
  [{ ...base, phase: 'tool', line: '⏵ 跑一下测试 · bash npm test · 7s', label: 'bash', detail: 'npm test', phrase: '跑一下测试' }, 'bash npm test · 7s'],
  [{ ...base, phase: 'done', line: '搞定 ✓ · 0 工具 · 想2s 干0s' }, 'Done ✓ · 0 tools · thought 2s · worked 0s'],
  [{ ...base, phase: 'done', line: '搞定 ✓ · bash npm test · 1 工具 · 🔥 12.3k' }, 'Done ✓ · bash npm test · 1 tool · 🔥 12.3k'],
]

for (const [state, expected] of cases) {
  const localized = localizeActivityState(state, 'en')
  assert.equal(localized.line, expected)
  assert.doesNotMatch(localized.line, /[\u3400-\u9fff]/u)
}

const chinese = cases[0][0]
assert.equal(localizeActivityState(chinese, 'zh'), chinese)

console.log('activity i18n OK (waiting, thinking, narration, done summary, done fragment)')
