import { Show } from "solid-js"
import type { MouseEvent } from "@opentui/core"
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
        <text fg={theme.border.default} selectable={false}>
          ┃
        </text>
        <box
          flexDirection="row"
          alignItems="center"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.background.surface.offset}
        >
          <text
            fg={props.current > 1 ? theme.text.default : theme.text.subdued}
            selectable={false}
            onMouseUp={(e) => {
              activate(e, props.onPrevious)
            }}
          >
            ↑
          </text>
          <text fg={theme.text.subdued} selectable={false}>
            {props.current} of {props.total}
          </text>
          <text
            fg={props.current < props.total ? theme.text.default : theme.text.subdued}
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
