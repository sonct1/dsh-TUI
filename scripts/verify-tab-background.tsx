/** Regression check: tab expansion must preserve the surrounding background. */

process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal }, { render, Box, Text }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
  ])
void React

const COLS = 40
const ROWS = 8
const EXPECTED_BG = 0x242b3a
const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })

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

const instance = await render(
  <Box width={COLS} backgroundColor="#242b3a">
    <Text>{'x\treturn value'}</Text>
  </Box>,
  {
    stdout: new FakeStdout() as NodeJS.WriteStream,
    stdin: new FakeStdin() as NodeJS.ReadStream,
    stderr: new FakeStdout() as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

await new Promise(resolve => setTimeout(resolve, 100))

const line = term.buffer.active.getLine(term.buffer.active.baseY)
if (line === undefined) throw new Error('Rendered line is missing')
for (let x = 1; x < 8; x++) {
  const cell = line.getCell(x)
  const background = (cell?.getBgColor() ?? 0) & 0xffffff
  if (background !== EXPECTED_BG) {
    throw new Error(`Tab cell ${x} lost background: expected 0x${EXPECTED_BG.toString(16)}, got 0x${background.toString(16)}`)
  }
}

await instance.unmount()
term.dispose()
process.stdout.write('tab background regression passed\n')
