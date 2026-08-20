import React from 'react'
import { Box, Text } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { formatDuration } from '../../trajectory/format.js'
import type { InspectDetail, InspectTabId } from '../../dsh-adapter/trajectory/index.js'
import type { TrajNode } from '../../dsh-adapter/types.js'

interface DisplayLine {
  readonly text: string
  readonly tone?: 'error' | 'dim'
  readonly head?: boolean
}

/** Wrap by terminal cells so CJK output pages without destructive clipping. */
export function wrapInspectorLine(text: string, width: number): readonly string[] {
  const limit = Math.max(1, width)
  if (text === '') return ['']
  const lines: string[] = []
  let line = ''
  let used = 0
  for (const char of text) {
    const cells = stringWidth(char)
    if (used > 0 && used + cells > limit) {
      lines.push(line)
      line = ''
      used = 0
    }
    // A zero-width combining mark follows its base even at a narrow width.
    line += char
    used += cells
  }
  lines.push(line)
  return lines
}

function tabLine(tabs: readonly { id: InspectTabId; label: string }[], activeTab: number): string {
  return tabs.map((tab, index) => `${index === activeTab ? '●' : '○'} ${tab.label}`).join('  ')
}

/** The inspector keeps a fixed slot, or becomes a paged full-height reader. */
export function Inspector({
  node,
  detail,
  height,
  width,
  expanded,
  scroll,
  activeTab,
  member,
}: {
  node: TrajNode | undefined
  detail: InspectDetail | undefined
  height: number
  width: number
  expanded: boolean
  scroll: number
  /** Selected tab index; the scene clamps it when the focused node changes. */
  activeTab: number
  /** Selected logical call when the ledger row is a folded burst. */
  member?: { readonly index: number; readonly count: number }
}): React.ReactNode {
  const bodyHeight = Math.max(1, height - 2)
  if (node === undefined || detail === undefined) {
    return <Box flexDirection="column" height={height} flexShrink={0}><Text color="subtle">—</Text></Box>
  }

  const tabIndex = Math.min(Math.max(0, activeTab), detail.tabs.length - 1)
  const tab = detail.tabs[tabIndex]!
  const lines: DisplayLine[] = []
  const contentWidth = Math.max(1, width - 4)
  for (const section of tab.sections) {
    lines.push({ text: section.title, tone: section.tone, head: true })
    for (const raw of section.body.split('\n')) {
      for (const wrapped of wrapInspectorLine(raw.replace(/\t/g, '  '), contentWidth)) lines.push({ text: wrapped, tone: section.tone })
    }
  }

  const overflow = lines.length - scroll > bodyHeight
  const visibleCount = overflow ? bodyHeight - 1 : bodyHeight
  const clipped = lines.slice(scroll, scroll + visibleCount)
  const hidden = Math.max(0, lines.length - scroll - visibleCount)
  const body: (DisplayLine | null)[] = Array.from({ length: bodyHeight }, (_, index) => clipped[index] ?? null)
  const status = node.status === 'error' ? 'error' : node.status === 'running' ? 'success' : 'inactive'

  return (
    <Box flexDirection="column" height={height} flexShrink={0}>
      <Box flexDirection="row" gap={1} width="100%">
        <Text color={status} bold>{'▎'}{detail.title}</Text>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text wrap="truncate" color="subtle">
            {[
              member === undefined ? undefined : `member ${member.index + 1}/${member.count}`,
              ...detail.facts,
            ].filter((fact): fact is string => fact !== undefined).join(' · ')}
          </Text>
        </Box>
        <Box flexShrink={0}><Text color={status}>{node.durationMs === undefined ? '' : formatDuration(node.durationMs)}</Text></Box>
      </Box>
      <Box width="100%" overflow="hidden">
        <Text color="subtle" wrap="truncate">
          {`  ${tabLine(detail.tabs, tabIndex)}  · Tab/Shift+Tab tabs${member === undefined ? '' : ' · n/p members'}${expanded ? ' · j/k page' : ' · Enter expand'}`}
        </Text>
      </Box>
      {body.map((line, index) => {
        const isMarker = overflow && index === bodyHeight - 1
        if (isMarker) return <Box key="more" width="100%" overflow="hidden"><Text color="subtle">{`    …${hidden} more · ${expanded ? 'j/k' : 'enter'}`}</Text></Box>
        if (line === null) return <Box key={index} width="100%"><Text> </Text></Box>
        return (
          <Box key={index} width="100%" overflow="hidden">
            <Text
              bold={line.head}
              color={line.head ? (line.tone === 'error' ? 'error' : 'permission') : line.tone === 'error' ? 'error' : line.tone === 'dim' ? 'subtle' : 'inactiveShimmer'}
            >
              {line.head ? `  ${line.text}` : `    ${line.text}`}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
