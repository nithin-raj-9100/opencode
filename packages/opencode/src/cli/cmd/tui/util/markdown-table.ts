import { Marked } from "marked"

/**
 * Format markdown tables into terminal-friendly box-drawing format
 * Uses Unicode box-drawing characters for clean table rendering
 */
export function formatMarkdownTables(markdown: string): string {
  const marked = new Marked({ gfm: true })
  const tokens = marked.lexer(markdown)

  let result = markdown
  let offset = 0

  for (const token of tokens) {
    if (token.type === "table" && "header" in token && "rows" in token) {
      const formattedTable = renderTerminalTable(token as TableToken)
      const start = (token.raw as any).start ?? 0
      const end = start + token.raw.length

      // Replace table markdown with formatted version
      const before = result.substring(0, start + offset)
      const after = result.substring(end + offset)
      result = before + formattedTable + after

      // Update offset for subsequent replacements
      offset += formattedTable.length - token.raw.length
    }
  }

  return result
}

interface TableToken {
  type: "table"
  header: Array<{ text: string }>
  rows: Array<Array<{ text: string }>>
  raw: string
}

function renderTerminalTable(token: TableToken): string {
  const headers = token.header.map((cell) => stripMarkdown(cell.text))
  const rows = token.rows.map((row) => row.map((cell) => stripMarkdown(cell.text)))

  // Calculate column widths
  const colWidths: number[] = headers.map((h) => h.length)
  rows.forEach((row) => {
    row.forEach((cell, i) => {
      colWidths[i] = Math.max(colWidths[i] || 0, cell.length)
    })
  })

  const lines: string[] = []

  // Top border: ┌───┬───┐
  lines.push("┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐")

  // Header row: │ Col1 │ Col2 │
  lines.push(
    "│ " +
      headers.map((h, i) => h.padEnd(colWidths[i])).join(" │ ") +
      " │",
  )

  // Header separator: ├───┼───┤
  lines.push("├" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┤")

  // Data rows: │ val1 │ val2 │
  rows.forEach((row) => {
    lines.push(
      "│ " +
        row.map((cell, i) => cell.padEnd(colWidths[i])).join(" │ ") +
        " │",
    )
  })

  // Bottom border: └───┴───┘
  lines.push("└" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘")

  return "\n" + lines.join("\n") + "\n"
}

/**
 * Strip inline markdown formatting from cell text
 * Removes **bold**, *italic*, `code`, [links](url), etc.
 */
function stripMarkdown(text: string): string {
  return (
    text
      // Remove links: [text](url) -> text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove bold: **text** or __text__ -> text
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      // Remove italic: *text* or _text_ -> text
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      // Remove inline code: `text` -> text
      .replace(/`([^`]+)`/g, "$1")
      // Remove strikethrough: ~~text~~ -> text
      .replace(/~~([^~]+)~~/g, "$1")
      .trim()
  )
}
