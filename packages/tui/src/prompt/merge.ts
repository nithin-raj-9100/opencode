import type { PromptInfo } from "./history"

type Mention = { start: number; end: number; text: string }

function shiftMention<T extends { mention?: Mention }>(part: T, offset: number): T {
  if (!part.mention) return { ...part }
  return { ...part, mention: { ...part.mention, start: part.mention.start + offset, end: part.mention.end + offset } }
}

/**
 * Concatenate prompts into a single composer entry, one per line.
 *
 * Attachment mentions carry absolute offsets into `text`, so every part after the first
 * prompt has to be shifted by the length of the text preceding it (plus the newline
 * separator) or its highlight lands on the wrong characters.
 */
export function mergePrompts(prompts: PromptInfo[]): PromptInfo {
  const merged: PromptInfo = { text: "", files: [], agents: [], skills: [], pasted: [] }
  const texts: string[] = []
  let offset = 0

  for (const prompt of prompts) {
    merged.files!.push(...(prompt.files ?? []).map((part) => shiftMention(part, offset)))
    merged.agents!.push(...(prompt.agents ?? []).map((part) => shiftMention(part, offset)))
    merged.skills!.push(...(prompt.skills ?? []).map((part) => shiftMention(part, offset)))
    merged.pasted.push(
      ...prompt.pasted.map((part) => ({
        ...part,
        source: { ...part.source, start: part.source.start + offset, end: part.source.end + offset },
      })),
    )
    texts.push(prompt.text)
    offset += prompt.text.length + 1
  }

  merged.text = texts.join("\n")
  return merged
}
