import React from 'react'
import { Box, Text } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import type { FileCandidate } from '../utils/fileSuggestions.js'

/**
 * The `@` file-completion overlay in CC's suggestion style: full relative
 * path (directory suffix stripped) + a `file`/`directory` description. The
 * selected row renders in the theme's `suggestion` color, others dim. The
 * name column is padded to a fixed display width so the description column
 * keeps its contract at narrow terminals (pinned by verify-cjk-truncate.tsx);
 * every pad/truncate uses display width, so CJK names never split a glyph.
 */
export function FileSuggestions({
  files,
  selectedIndex,
  columns,
}: {
  files: readonly FileCandidate[]
  selectedIndex: number
  columns: number
}): React.ReactNode {
  if (files.length === 0) return null

  const maxVisible = 6
  const safeIndex = Math.min(Math.max(0, selectedIndex), files.length - 1)
  const startIndex = Math.max(
    0,
    Math.min(
      safeIndex - Math.floor(maxVisible / 2),
      Math.max(0, files.length - maxVisible),
    ),
  )
  const visible = files.slice(startIndex, startIndex + maxVisible)

  const nameOf = (file: FileCandidate): string =>
    file.kind === 'directory' && file.path.endsWith('/')
      ? file.path.slice(0, -1)
      : file.path

  const NAME_COLUMN = 20
  const descriptionWidth = Math.max(0, columns - 24)

  return (
    <Box flexDirection="column">
      {visible.map(file => {
        const isSelected = file.id === files[safeIndex]?.id
        const name = nameOf(file)
        const icon = file.kind === 'directory' ? '▸ ' : '+ '
        const padded = name + ' '.repeat(Math.max(1, NAME_COLUMN - stringWidth(name)))
        const description = file.kind === 'directory' ? 'directory' : 'file'
        const renderedDescription =
          stringWidth(description) > descriptionWidth
            ? truncateToWidth(description, Math.max(0, descriptionWidth - 1)) + '…'
            : description
        return (
          <Text key={file.id} wrap="truncate">
            <Text color={isSelected ? 'suggestion' : undefined} dimColor={!isSelected}>
              {icon}
              {padded}
            </Text>
            <Text color={isSelected ? 'suggestion' : undefined} dimColor={!isSelected}>
              {renderedDescription}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}
