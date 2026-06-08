const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function segmentWidth(value: string) {
  return value === "\n" ? 1 : Bun.stringWidth(value)
}

export function promptOffsetWidth(value: string) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    // Textarea offsets count newlines as one position; Bun.stringWidth counts them as zero.
    width += segmentWidth(part.segment)
  }
  return width
}

function displayOffsetIndex(value: string, offset: number) {
  if (offset <= 0) return 0

  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + segmentWidth(part.segment)
    if (next > offset) return part.index
    width = next
  }

  return value.length
}

export function displaySlice(value: string, start = 0, end = promptOffsetWidth(value)) {
  return value.slice(displayOffsetIndex(value, start), displayOffsetIndex(value, end))
}

export function displayCharAt(value: string, offset: number) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + segmentWidth(part.segment)
    if (offset === width || offset < next) return part.segment
    width = next
  }
}

export function mentionTriggerIndex(value: string, offset?: number) {
  const limit = offset ?? Number.POSITIVE_INFINITY
  let width = 0
  let index: number | undefined
  let before: string | undefined
  let queryHasWhitespace = false
  for (const part of graphemes.segment(value)) {
    const next = width + segmentWidth(part.segment)
    if (next > limit) break

    if (part.segment === "@") {
      index = width
      before = part.index === 0 ? undefined : value[part.index - 1]
      queryHasWhitespace = false
    } else if (index !== undefined && /\s/.test(part.segment)) {
      queryHasWhitespace = true
    }
    width = next
  }

  if (index !== undefined && (before === undefined || /\s/.test(before)) && !queryHasWhitespace) {
    return index
  }
}
