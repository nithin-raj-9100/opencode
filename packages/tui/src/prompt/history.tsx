import path from "path"
import { createStore, produce, unwrap } from "solid-js/store"
import type { PromptInput } from "@opencode/schema"
import type { Types } from "effect"
import { Hash } from "@opencode/util/hash"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, readText, writeText } from "../util/persistence"

export type PastedText = {
  text: string
  source: {
    start: number
    end: number
    text: string
  }
}

export type PromptInfo = Types.DeepMutable<Pick<PromptInput.Prompt, "text" | "files" | "agents" | "skills">> & {
  pasted: PastedText[]
  mode?: "normal" | "shell"
}

export type PromptPartRef = {
  type: "file" | "agent" | "skill" | "pasted"
  index: number
}

export const emptyPrompt = (): PromptInfo => ({ text: "", files: [], agents: [], skills: [], pasted: [] })

export const MAX_HISTORY_ENTRIES = 50

export function parsePromptHistory(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return parsePromptInfo(JSON.parse(line))
      } catch {
        return undefined
      }
    })
    .filter((line): line is PromptInfo => line !== undefined)
    .slice(-MAX_HISTORY_ENTRIES)
}

export function isDuplicateEntry(previous: PromptInfo | undefined, next: PromptInfo): boolean {
  if (!previous) return false
  return JSON.stringify(previous) === JSON.stringify(next)
}

export function parsePromptInfo(value: unknown): PromptInfo | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (typeof input.text !== "string" || !Array.isArray(input.pasted)) return
  return input as PromptInfo
}

export function promptHistoryScope(directory: string | undefined): string {
  return directory ?? ""
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const paths = useTuiPaths()
    // Pre-scoping history lived in one global file; it seeds a directory the first
    // time that directory is used, so upgrading does not empty the composer's recall.
    const legacyPath = path.join(paths.state, "prompt-history.jsonl")
    const scopePath = (scope: string) =>
      path.join(paths.state, "prompt-history", `${scope ? Hash.fast(scope) : "global"}.jsonl`)

    const [store, setStore] = createStore({ history: {} as Record<string, PromptInfo[]> })
    const indices = new Map<string, number>()
    const loading = new Map<string, Promise<void>>()

    function entries(scope: string) {
      return store.history[scope] ?? []
    }

    function persist(scope: string, lines: PromptInfo[]) {
      return writeText(scopePath(scope), lines.map((line) => JSON.stringify(line)).join("\n") + "\n").catch(() => {})
    }

    // The provider is an app singleton, so scopes are loaded lazily on first use
    // rather than at mount. Consumers call ensure() when their directory changes so
    // the read has settled before the first arrow press.
    function ensure(scope: string) {
      const inflight = loading.get(scope)
      if (inflight) return inflight
      const task = (async () => {
        const scoped = parsePromptHistory(await readText(scopePath(scope)).catch(() => ""))
        if (scoped.length > 0) {
          setStore("history", scope, scoped)
          // Rewrite valid retained entries to self-heal corruption and enforce the limit.
          await persist(scope, scoped)
          return
        }
        const seed = parsePromptHistory(await readText(legacyPath).catch(() => ""))
        setStore("history", scope, seed)
        if (seed.length > 0) await persist(scope, seed)
      })()
      loading.set(scope, task)
      return task
    }

    return {
      ensure,
      move(scope: string, direction: 1 | -1, input: string) {
        void ensure(scope)
        const items = entries(scope)
        if (!items.length) return undefined
        const index = indices.get(scope) ?? 0
        const current = items.at(index)
        if (!current) return undefined
        if (current.text !== input && input.length) return
        const next = index + direction
        if (Math.abs(next) > items.length || next > 0) return
        indices.set(scope, next)
        if (next === 0) return emptyPrompt()
        return items.at(next)
      },
      append(scope: string, item: PromptInfo) {
        void ensure(scope)
        const entry = structuredClone(unwrap(item))
        if (isDuplicateEntry(entries(scope).at(-1), entry)) {
          indices.set(scope, 0)
          return
        }
        let trimmed = false
        setStore(
          produce((draft) => {
            const list = (draft.history[scope] ??= [])
            list.push(entry)
            if (list.length > MAX_HISTORY_ENTRIES) {
              draft.history[scope] = list.slice(-MAX_HISTORY_ENTRIES)
              trimmed = true
            }
          }),
        )
        indices.set(scope, 0)

        if (trimmed) {
          void persist(scope, entries(scope))
          return
        }
        appendText(scopePath(scope), JSON.stringify(entry) + "\n").catch(() => {})
      },
    }
  },
})
