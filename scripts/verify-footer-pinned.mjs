/**
 * Footer-pinning regression: the transient status rows (working
 * spinner/activity line, plugin status contributions, new-messages pill)
 * must mount/unmount inside a fixed two-row band above the prompt, so the
 * prompt input and StatusLine stay on the SAME screen rows in every state —
 * in both inline and fullscreen renders. The goal/todo panel rides the
 * transcript (Claude Code semantics), visible at the bottom of the scroll
 * area instead of the footer.
 *
 * Run with plain node against the compiled lib:
 * `node scripts/verify-footer-pinned.mjs`
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import xtermHeadless from '@xterm/headless'
const { Terminal } = xtermHeadless
import { render, AlternateScreen } from '../lib/types/ui.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { QuestionStore } from '../lib/types/dsh-adapter/questions.js'
import { TuiStatusStore } from '../lib/types/dsh-adapter/status.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeHarness(cols, rows) {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  class FakeStdout extends Writable {
    constructor() { super(); this.columns = cols; this.rows = rows; this.isTTY = true }
    _write(chunk, _enc, cb) { term.write(String(chunk), cb) }
  }
  const stdout = new FakeStdout()
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const lines = () => {
    const buf = term.buffer.active
    const vy = buf.viewportY
    return Array.from({ length: rows }, (_, y) => {
      const cell = buf.getLine(vy + y)
      let s = ''
      for (let x = 0; x < cols; x++) s += cell?.getCell(x)?.getChars() ?? ' '
      return s
    })
  }
  return { stdout, stderr, stdin, lines }
}

function makeChannel(listeners) {
  return {
    version: 0,
    rows: [
      { id: 0, kind: 'user', text: 'hello' },
      { id: 1, kind: 'assistant', text: 'hi there', time: Date.now() },
    ],
    status: 'idle',
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    tokens: { input: 120, output: 45 },
    cwd: 'C:/code/demo-project',
    displayCwd: 'C:/code/demo-project',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 20,
    activeToolCount: 0,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    turnStart: Date.now(),
    lastUserText: 'hello',
    pending: [],
    commandList: [],
    notifications: [],
    activityEnabled: true,
    activityFrames: [],
    contextBarEnabled: true,
    contextWindow: 1_000_000,
    contextSegments: { system: 100, prompt: 200, assistant: 300, thinking: 0, tools: 0 },
    workingActivity: undefined,
    goal: undefined,
    todos: [],
    lastUsage: undefined,
    tps: undefined,
    tpsSamples: [],
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
    submit() {}, steer() {}, cancel() {}, clear() {}, notify() {},
    listModels: () => Promise.resolve([]),
  }
}

function inputBorderRow(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^─+$/.test(lines[i])) return i
  }
  return -1
}
function inputPromptRow(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('❯')) return i
  }
  return -1
}
function statusFieldsRow(lines) {
  return lines.findIndex(l => l.includes('deepseek-v4-flash') && l.includes('main'))
}
function activityRow(lines) {
  return lines.findIndex(l => l.includes('extended-status'))
}

async function scenario(cols, rows, fullscreen, label) {
  const listeners = new Set()
  const channel = makeChannel(listeners)
  const { stdout, stderr, stdin, lines } = makeHarness(cols, rows)
  const tree = fullscreen
    ? React.createElement(AlternateScreen, null,
        React.createElement(Chat, { channel, questionStore: new QuestionStore(), onExit: () => {}, fullscreen: true }))
    : React.createElement(Chat, { channel, questionStore: new QuestionStore(), onExit: () => {} })
  const app = await render(tree, { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false })
  await sleep(400)

  const snap = () => [inputBorderRow(lines()), statusFieldsRow(lines())]
  const emit = () => { channel.version++; for (const l of [...listeners]) l() }

  const states = []
  states.push(['idle', snap()])
  channel.working = true
  emit()
  await sleep(200)
  states.push(['spinner', snap()])
  channel.workingActivity = {
    // phase 'done' renders statically (no shimmer sweep), so the line
    // reads back verbatim from the harness terminal.
    phase: 'done',
    line: 'Running the extended-status scenario',
    toolCount: 1,
    turnElapsedMs: 10_000,
    phaseStartedAt: Date.now() - 10_000,
  }
  emit()
  await sleep(200)
  states.push(['activity', snap()])
  const activity = activityRow(lines())
  channel.goal = { id: 'g1', objective: 'Ship the release', status: 'active' }
  channel.todos = [
    { id: 't1', title: 'Write tests', status: 'pending' },
    { id: 't2', title: 'Bump version', status: 'in-progress' },
  ]
  emit()
  await sleep(200)
  states.push(['goal', snap()])
  channel.working = false
  channel.workingActivity = undefined
  emit()
  await sleep(200)
  states.push(['idle-goal', snap()])

  // Geometry must be identical in every state (footer pinned).
  const anchors = states.map(([, s]) => s.join(','))
  check(
    `${label}: input/status rows constant across states`,
    new Set(anchors).size === 1,
    [...new Set(anchors)].join(' vs '),
  )

  // The activity line lives in the fixed band row: two rows above the input
  // (band row 1 = activity, band row 2 = plugin status/nothing).
  const input = inputPromptRow(lines())
  check(
    `${label} activity line visible in its fixed slot`,
    activity !== -1 && input !== -1 && activity === input - 3,
    `activity=${activity} input=${input}`,
  )

  // The goal panel rides the transcript (visible on screen, not in the
  // footer band): the 🎯 goal header renders somewhere above the input.
  const screen = lines().join('\n')
  check(
    `${label}: goal panel present in transcript area`,
    screen.includes('🎯'),
  )
  app.unmount()
  await sleep(80)
}

await scenario(110, 30, false, 'inline 110x30')
await scenario(110, 30, true, 'fullscreen 110x30')

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`)
process.exit(failed === 0 ? 0 : 1)