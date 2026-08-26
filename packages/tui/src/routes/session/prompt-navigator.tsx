import { createSignal, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"

export function PromptNavigator(props: {
  total: () => number
  current: () => number
  showScrollbar: () => boolean
  onNavigate: (direction: "prev" | "next") => void
}) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal<"up" | "down" | null>(null)

  return (
    <Show when={props.total() > 0}>
      <box
        position="absolute"
        top={0}
        right={props.showScrollbar() ? 3 : 1}
        zIndex={100}
        flexDirection="row"
        alignItems="center"
        backgroundColor={theme.backgroundPanel}
        borderColor={theme.border}
        border={["left", "bottom"]}
        customBorderChars={SplitBorder.customBorderChars}
        paddingLeft={1}
        paddingRight={1}
        gap={1}
      >
        <text fg={theme.textMuted}>{`${props.current()} of ${props.total()}`}</text>
        <box
          onMouseOver={() => setHover("up")}
          onMouseOut={() => setHover(null)}
          onMouseUp={() => props.onNavigate("prev")}
          backgroundColor={hover() === "up" ? theme.backgroundElement : theme.backgroundPanel}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={hover() === "up" ? theme.text : theme.textMuted}>↑</text>
        </box>
        <box
          onMouseOver={() => setHover("down")}
          onMouseOut={() => setHover(null)}
          onMouseUp={() => props.onNavigate("next")}
          backgroundColor={hover() === "down" ? theme.backgroundElement : theme.backgroundPanel}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={hover() === "down" ? theme.text : theme.textMuted}>↓</text>
        </box>
      </box>
    </Show>
  )
}
