/**
 * Inline native-cursor regression: when the rendered frame is taller than the
 * terminal viewport, the declared caret and the renderer's parked cursor must
 * stay in the same frame-coordinate system. Mixing viewport coordinates with
 * frame.cursor causes oversized CUU/CUD moves to clamp at the margins, then
 * subsequent incremental diffs overwrite the wrong rows.
 *
 * Run: node --import tsx/esm scripts/verify-inline-cursor.tsx
 */
export {}

process.env.FORCE_COLOR = '3'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, Box, Text },
  { useDeclaredCursor },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/ink/hooks/use-declared-cursor.js'),
])

const COLS = 50
const ROWS = 10
const term = new XTerm({
  cols: COLS,
  rows: ROWS,
  scrollback: 100,
  allowProposedApi: true,
})

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true

  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    term.write(String(chunk), callback)
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

function LongFrame(): React.ReactNode {
  const caretRef = useDeclaredCursor({ line: 0, column: 0, active: true })
  return (
    <Box flexDirection="column">
      {Array.from({ length: 24 }, (_, index) => (
        <Text key={index}>{`ROW_${String(index).padStart(2, '0')}`}</Text>
      ))}
      <Box ref={caretRef}>
        <Text inverse>CARET</Text>
      </Box>
      <Text>TAIL</Text>
    </Box>
  )
}

const stdout = new FakeStdout() as FakeStdout & NodeJS.WriteStream
const stdin = new FakeStdin() as FakeStdin & NodeJS.ReadStream
const app = await render(<LongFrame />, {
  stdout,
  stdin,
  stderr: stdout,
  exitOnCtrlC: false,
  patchConsole: false,
})

await new Promise(resolve => setTimeout(resolve, 700))

const buffer = term.buffer.active
let caret: { x: number; y: number } | undefined
for (let y = 0; y < ROWS; y++) {
  const line = buffer.getLine(buffer.viewportY + y)
  if (!line) continue
  for (let x = 0; x < COLS; x++) {
    if (line.getCell(x)?.isInverse()) {
      caret = { x, y }
      break
    }
  }
  if (caret) break
}

const cursor = { x: buffer.cursorX, y: buffer.cursorY }
const ok = caret !== undefined && cursor.x === caret.x && cursor.y === caret.y

try { app.unmount() } catch {}

if (!ok) {
  console.error(
    `FAIL: long inline frame cursor missed caret ` +
    `(caret=${JSON.stringify(caret)}, cursor=${JSON.stringify(cursor)}, ` +
    `baseY=${buffer.baseY}, viewportY=${buffer.viewportY})`,
  )
  process.exit(1)
}

console.log(
  `PASS: long inline frame cursor matches caret ` +
  `(caret=${JSON.stringify(caret)}, cursor=${JSON.stringify(cursor)})`,
)
process.exit(0)
