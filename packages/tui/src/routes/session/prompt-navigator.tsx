import { Show } from "solid-js"
import { useTheme } from "../../context/theme"

export interface PromptNavigatorProps {
  current: number
  total: number
  onPrevious: () => void
  onNext: () => void
}

export function PromptNavigator(props: PromptNavigatorProps) {
  const theme = useTheme()

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
      >
        <text fg={theme.border.default}>┃</text>
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
            onMouseUp={(e) => {
              if (e.button === 0) props.onPrevious()
            }}
          >
            ↑
          </text>
          <text fg={theme.text.subdued}>
            {props.current} of {props.total}
          </text>
          <text
            fg={props.current < props.total ? theme.text.default : theme.text.subdued}
            onMouseUp={(e) => {
              if (e.button === 0) props.onNext()
            }}
          >
            ↓
          </text>
        </box>
      </box>
    </Show>
  )
}
