import { createEffect, createMemo, createSignal, on, Show, type Accessor } from "solid-js"
import type { MouseEvent } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { useTheme } from "../../context/theme"

export interface PromptNavigatorProps {
  current: number
  total: number
  onPrevious: () => void
  onNext: () => void
}

export function promptNavigationIndex(current: number, total: number, direction: "prev" | "next") {
  if (total === 0) return
  if (direction === "prev") return Math.max(0, current - 2)
  return Math.min(total - 1, current)
}

/**
 * Every user prompt in the session, in timeline order. The transcript store only holds the newest
 * pages of messages, so counting loaded messages undercounts long sessions and shrinks whenever the
 * window is reset by a resync or eviction. The server's type-filtered listing is the source of truth;
 * loaded prompts it has not returned yet are newer and follow it.
 */
export function createPromptIndex(input: {
  sessionID: Accessor<string>
  connected: Accessor<boolean>
  messages: Accessor<readonly SessionMessageInfo[]>
  list: (query: { sessionID: string; cursor?: string }) => Promise<{
    data: readonly { id: string }[]
    cursor: { next?: string }
  }>
}) {
  const [indexed, setIndexed] = createSignal<{ sessionID: string; ids: readonly string[] }>()
  const loaded = createMemo(() => input.messages().flatMap((message) => (message.type === "user" ? [message.id] : [])))
  let generation = 0
  let seen = new Set<string>()

  const refresh = (sessionID: string) => {
    const current = ++generation
    void (async () => {
      const ids: string[] = []
      let cursor: string | undefined
      do {
        const page = await input.list({ sessionID, cursor })
        if (current !== generation) return
        ids.push(...page.data.map((message) => message.id))
        cursor = page.cursor.next
      } while (cursor)
      setIndexed({ sessionID, ids })
    })().catch(() => undefined)
  }

  createEffect(
    on([input.sessionID, input.connected], ([sessionID, connected]) => {
      seen = new Set()
      if (connected) refresh(sessionID)
    }),
  )
  // Appended prompts merge locally. A prompt leaving the store means a revert, cancel, or window
  // reset, and only the server knows which, so re-read the index.
  createEffect(
    on(loaded, (ids) => {
      const current = new Set(ids)
      const removed = [...seen].some((id) => !current.has(id))
      seen = current
      if (removed && input.connected()) refresh(input.sessionID())
    }),
  )

  return createMemo(() => {
    const index = indexed()
    if (!index || index.sessionID !== input.sessionID()) return loaded()
    const known = new Set(index.ids)
    return [...index.ids, ...loaded().filter((id) => !known.has(id))]
  })
}

/**
 * The 1-based position of the prompt whose turn is at the top of the viewport. Anchors only exist for
 * mounted rows, and older prompts may not be loaded at all, so the owning prompt is resolved through
 * the loaded messages and then located in the full prompt index.
 */
export function viewedPromptNumber(input: {
  prompts: readonly string[]
  messages: readonly SessionMessageInfo[]
  positions: readonly { id: string; y: number }[]
  top: number
}) {
  if (input.prompts.length === 0) return 0
  const viewed = input.positions.findLast((position) => position.y <= input.top) ?? input.positions[0]
  const index = viewed ? input.messages.findIndex((message) => message.id === viewed.id) : -1
  if (index === -1) return input.prompts.length
  const owner = input.messages.slice(0, index + 1).findLast((message) => message.type === "user")
  const position = owner ? input.prompts.indexOf(owner.id) : -1
  if (position !== -1) return position + 1
  // The view is above every loaded prompt, so it belongs to the newest prompt that is not loaded.
  const first = input.messages.find((message) => message.type === "user")
  if (!first) return input.prompts.length
  return Math.max(1, input.prompts.indexOf(first.id))
}

export function PromptNavigator(props: PromptNavigatorProps) {
  const theme = useTheme()
  const blockSelection = (event: MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
  }
  const activate = (event: MouseEvent, action: () => void) => {
    if (event.button !== 0) return
    blockSelection(event)
    action()
  }

  return (
    <Show when={props.total > 0}>
      <box
        flexDirection="row"
        alignItems="center"
        justifyContent="flex-end"
        gap={1}
        position="absolute"
        top={0}
        right={1}
        zIndex={100}
        onMouseDown={blockSelection}
        onMouseUp={blockSelection}
      >
        <text fg={theme.border.base} selectable={false}>
          ┃
        </text>
        <box
          flexDirection="row"
          alignItems="center"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.background.raised.base}
        >
          <text
            fg={props.current > 1 ? theme.text.base : theme.text.muted}
            selectable={false}
            onMouseUp={(e) => {
              activate(e, props.onPrevious)
            }}
          >
            ↑
          </text>
          <text fg={theme.text.muted} selectable={false}>
            {props.current} of {props.total}
          </text>
          <text
            fg={props.current < props.total ? theme.text.base : theme.text.muted}
            selectable={false}
            onMouseUp={(e) => {
              activate(e, props.onNext)
            }}
          >
            ↓
          </text>
        </box>
      </box>
    </Show>
  )
}
