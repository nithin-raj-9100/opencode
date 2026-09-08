import { describe, expect, test } from "bun:test"
import { mergePrompts } from "../../src/prompt/merge"
import type { PromptInfo } from "../../src/prompt/history"

const entry = (text: string, overrides: Partial<PromptInfo> = {}): PromptInfo => ({
  text,
  files: [],
  agents: [],
  skills: [],
  pasted: [],
  ...overrides,
})

describe("mergePrompts", () => {
  test("joins prompts one per line, oldest first", () => {
    expect(mergePrompts([entry("first"), entry("second"), entry("third")]).text).toBe("first\nsecond\nthird")
  })

  test("returns an empty prompt for no input", () => {
    expect(mergePrompts([])).toEqual(entry(""))
  })

  test("preserves a single prompt unchanged", () => {
    expect(mergePrompts([entry("only")]).text).toBe("only")
  })

  test("shifts file mention offsets to their merged position", () => {
    const merged = mergePrompts([
      entry("read @a.ts", { files: [{ uri: "a.ts", mention: { start: 5, end: 10, text: "@a.ts" } }] }),
      entry("then @b.ts", { files: [{ uri: "b.ts", mention: { start: 5, end: 10, text: "@b.ts" } }] }),
    ])

    expect(merged.text).toBe("read @a.ts\nthen @b.ts")
    expect(merged.files?.[0]?.mention).toEqual({ start: 5, end: 10, text: "@a.ts" })
    // second prompt starts at offset 11 ("read @a.ts" is 10 chars + the newline)
    expect(merged.files?.[1]?.mention).toEqual({ start: 16, end: 21, text: "@b.ts" })
    expect(merged.text.slice(16, 21)).toBe("@b.ts")
  })

  test("shifts agent and skill mentions too", () => {
    const merged = mergePrompts([
      entry("hi"),
      entry("ask @bot", { agents: [{ name: "bot", mention: { start: 4, end: 8, text: "@bot" } }] }),
      entry("use @sk", { skills: [{ id: "sk", mention: { start: 4, end: 7, text: "@sk" } }] as PromptInfo["skills"] }),
    ])

    expect(merged.text).toBe("hi\nask @bot\nuse @sk")
    expect(merged.text.slice(merged.agents![0]!.mention!.start, merged.agents![0]!.mention!.end)).toBe("@bot")
    expect(merged.text.slice(merged.skills![0]!.mention!.start, merged.skills![0]!.mention!.end)).toBe("@sk")
  })

  test("shifts pasted-text source offsets", () => {
    const merged = mergePrompts([
      entry("one"),
      entry("paste [#1]", { pasted: [{ text: "big", source: { start: 6, end: 10, text: "[#1]" } }] }),
    ])

    expect(merged.text.slice(merged.pasted[0]!.source.start, merged.pasted[0]!.source.end)).toBe("[#1]")
  })

  test("does not mutate the inputs", () => {
    const first = entry("read @a.ts", { files: [{ uri: "a.ts", mention: { start: 5, end: 10, text: "@a.ts" } }] })
    const second = entry("then @b.ts", { files: [{ uri: "b.ts", mention: { start: 5, end: 10, text: "@b.ts" } }] })
    mergePrompts([first, second])

    expect(second.files?.[0]?.mention).toEqual({ start: 5, end: 10, text: "@b.ts" })
  })
})
