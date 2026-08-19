/**
 * Regression check for the narration-only assistant row filter in
 * MessageList: a settled row whose text is only the ⏵ status line strips to
 * nothing and must NOT render as a lone ● bullet, while streaming rows and
 * rows with real content stay visible.
 *
 * Run: node --import tsx/esm scripts/verify-narration-row-filter.tsx
 */
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { render } from '../src/ui.js'
import { MessageList } from '../src/components/MessageList.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class Output extends Writable {
  columns = 120
  rows = 36
  isTTY = true
  text = ''
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.text += String(chunk)
    callback()
  }
}

class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

const rows = [
  // Settled narration-only step (e.g. "⏵ …" then an immediate tool call):
  // previously rendered as a lone ● bullet above the tool card.
  { id: 1, kind: 'assistant' as const, text: '⏵ Verifying the adapter mapping', streaming: false },
  // Settled reply with narration + real content: stays, narration stripped.
  { id: 2, kind: 'assistant' as const, text: '⏵ Summarizing\n\nReal answer body', streaming: false },
  // Live streaming narration-only row: kept so the bullet signals activity.
  { id: 3, kind: 'assistant' as const, text: '⏵ Checking results', streaming: true },
]

const stdout = new Output()
const stderr = new Output()
const stdin = new Input()
const instance = await render(<MessageList
  rows={rows}
  expanded={false}
  expandedRows={new Set()}
  selectedId={null}
  onToggleRow={() => {}}
  model="deepseek-chat"
  showAll
  onToggleAll={() => {}}
/>, {
  stdout,
  stderr,
  stdin,
  exitOnCtrlC: false,
  patchConsole: false,
})

await sleep(300)
await instance.unmount()
const output = stdout.text + stderr.text
// The frame writes styled segments (SGR splits words), so match on the
// ANSI-stripped, whitespace-normalized text.
const plain = output
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][0-9A-B]|\x1b[>=<]|\x1b\][^\x07]*\x07/g, '')
  .replace(/\s+/g, '')

let failed = false
const bullets = (output.match(/●/g) ?? []).length
if (bullets !== 2) {
  console.error(`FAIL: expected 2 ● bullets (content row + streaming row), got ${bullets}`)
  failed = true
}
if (plain.includes('Verifyingtheadaptermapping')) {
  console.error('FAIL: settled narration-only row leaked into the transcript')
  failed = true
}
if (!plain.includes('Realanswerbody')) {
  console.error('FAIL: content row missing')
  failed = true
}
if (plain.includes('⏵Summarizing')) {
  console.error('FAIL: narration line was not stripped from the content row')
  failed = true
}
if (!failed) {
  console.log('PASS: settled narration-only rows hidden, streaming and content rows intact')
}
process.exit(failed ? 1 : 0)
