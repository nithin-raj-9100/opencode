import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, Match, onCleanup, Show, Switch } from "solid-js"
import { footerFeedback, footerLabel, liveTimeUsedSeconds, nextChargingStartedAt } from "../../session/goal"
import { contextUsage, formatContextUsage } from "../../util/session"
import { useTerminalDimensions } from "@opentui/solid"
import { stringWidth } from "../../util/string-width"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function PromptFooter(props: {
  context: Plugin.Context
  sessionID?: string
  mode: "normal" | "shell"
  showDetails: boolean
}) {
  const dimensions = useTerminalDimensions()
  const [liveHovered, setLiveHovered] = createSignal(false)
  const subagents = createMemo(() => {
    if (!props.sessionID) return 0
    const count = props.context.data.session
      .family(props.sessionID)
      .filter((id) => id !== props.sessionID && props.context.data.session.status(id) === "running").length
    return count ? `${count} subagent${count === 1 ? "" : "s"}` : undefined
  })
  const shells = createMemo(() => {
    if (!props.sessionID) return 0
    const count = props.context.data.shell
      .list(props.context.location)
      .filter((shell) => shell.metadata.sessionID === props.sessionID).length
    return count ? `${count} shell${count === 1 ? "" : "s"}` : undefined
  })
  const goal = createMemo(() => {
    if (!props.sessionID) return
    return props.context.data.session.goal.get(props.sessionID)
  })
  const [now, setNow] = createSignal(Date.now())
  const [chargingStartedAt, setChargingStartedAt] = createSignal<number>()
  let charging:
    | {
        sessionID: string
        timeUsedSeconds: number
        startedAt: number
      }
    | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const current = goal()
    const running = Boolean(sessionID && props.context.data.session.status(sessionID) === "running")
    const startedAt =
      sessionID && current
        ? nextChargingStartedAt({
            sessionID,
            status: current.status,
            tokenBudget: current.tokenBudget,
            running,
            timeUsedSeconds: current.timeUsedSeconds,
            previous: charging,
            now: Date.now(),
          })
        : undefined
    charging =
      sessionID && startedAt !== undefined && current
        ? { sessionID, timeUsedSeconds: current.timeUsedSeconds, startedAt }
        : undefined
    setChargingStartedAt(startedAt)
    if (startedAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const goalText = createMemo(() => {
    const current = goal()
    if (!current) return
    const running = Boolean(props.sessionID && props.context.data.session.status(props.sessionID) === "running")
    return footerLabel({
      ...current,
      timeUsedSeconds: liveTimeUsedSeconds({
        status: current.status,
        tokenBudget: current.tokenBudget,
        timeUsedSeconds: current.timeUsedSeconds,
        running,
        chargingStartedAt: chargingStartedAt(),
        now: now(),
      }),
    })
  })
  const goalColor = createMemo(() => {
    const current = goal()
    if (!current) return props.context.theme.text.subdued
    return props.context.theme.text.feedback[footerFeedback(current.status)].default
  })
  const status = createMemo(() => {
    if (!props.sessionID) return []
    const session = props.context.data.session.get(props.sessionID)
    if (!session) return []
    const usage = contextUsage(
      props.context.data.session.message.list(props.sessionID),
      props.context.data.location.model.list(session.location),
      session.revert?.messageID,
    )
    const cost = props.context.data.session.cost(props.sessionID)
    return [
      usage ? formatContextUsage(usage.tokens, usage.percent) : undefined,
      cost > 0 ? money.format(cost) : undefined,
    ].filter((item): item is string => Boolean(item))
  })
  const live = createMemo(() => Boolean(subagents() || shells()))
  const shortcut = (id: string) => props.context.keymap.shortcuts(id)[0]
  const layout = createMemo(() => {
    const command = shortcut("command.palette.show")
    if (status().length === 0) return { usage: false, shortcuts: dimensions().width >= 44 }
    return promptFooterLayout({
      width: Math.max(0, dimensions().width - 8),
      usage: status(),
      shortcuts: command ? [`${command} commands`] : [],
    })
  })

  return (
    <Switch>
      <Match when={props.mode === "normal"}>
        <Switch>
          <Match when={live() || status().length > 0 || goalText()}>
            <box flexDirection="row" flexShrink={props.showDetails && layout().usage ? 0 : 1} minWidth={0}>
              <Show when={live()}>
                <box
                  flexShrink={0}
                  onMouseOver={() => setLiveHovered(true)}
                  onMouseOut={() => setLiveHovered(false)}
                  onMouseUp={() => props.context.keymap.dispatch("session.child.first")}
                >
                  <text
                    fg={liveHovered() ? props.context.theme.text.default : props.context.theme.text.subdued}
                    wrapMode="none"
                  >
                    <Show when={shortcut("session.child.first")}>
                      {(value) => <span style={{ fg: props.context.theme.text.default }}>{value()} </span>}
                    </Show>
                    <Show when={subagents()}>{(value) => <>{value()}</>}</Show>
                    <Show when={subagents() && shells()}> · </Show>
                    <Show when={shells()}>{(value) => <>{value()}</>}</Show>
                  </text>
                </box>
              </Show>
              <Show when={goalText()}>
                {(label) => (
                  <text fg={goalColor()} wrapMode="none" flexShrink={0}>
                    <Show when={live()}> · </Show>
                    {label()}
                  </text>
                )}
              </Show>
              <Show when={props.showDetails && layout().usage && status().length > 0}>
                <text fg={props.context.theme.text.subdued} wrapMode="none" flexShrink={0}>
                  <Show when={live() || goalText()}> · </Show>
                  {status().join(" · ")}
                </text>
              </Show>
            </box>
          </Match>
          <Match when={props.showDetails && layout().shortcuts}>
            <text fg={props.context.theme.text.default} flexShrink={0}>
              {shortcut("agent.cycle")} <span style={{ fg: props.context.theme.text.subdued }}>agents</span>
            </text>
          </Match>
        </Switch>
        <Show when={props.showDetails && layout().shortcuts}>
          <text fg={props.context.theme.text.default} wrapMode="none" flexShrink={0}>
            {shortcut("command.palette.show")} <span style={{ fg: props.context.theme.text.subdued }}>commands</span>
          </text>
        </Show>
      </Match>
      <Match when={props.mode === "shell"}>
        <text fg={props.context.theme.text.default} flexShrink={0}>
          esc{" "}
          <span style={{ fg: props.context.theme.text.subdued }}>
            {dimensions().width < 44 ? "shell" : "exit shell mode"}
          </span>
        </text>
      </Match>
    </Switch>
  )
}

export default Plugin.define({
  id: "opencode.prompt.footer",
  setup(context) {
    context.ui.slot({
      append: "prompt.footer",
      render: (props) => (
        <PromptFooter context={context} sessionID={props.sessionID} mode={props.mode} showDetails={props.showDetails} />
      ),
    })
  },
})

function promptFooterLayout(input: { width: number; usage: string[]; shortcuts: string[] }) {
  const usage = input.usage.join(" · ")
  const shortcuts = input.shortcuts.join(" · ")
  const available = Math.max(0, input.width - Math.min(28, Math.floor(input.width / 2)))
  if (usage && shortcuts && stringWidth(`${usage} · ${shortcuts}`) <= available) {
    return { usage: true, shortcuts: true }
  }
  if (usage && stringWidth(usage) <= available) return { usage: true, shortcuts: false }
  if (!usage && shortcuts && stringWidth(shortcuts) <= available) return { usage: false, shortcuts: true }
  return { usage: false, shortcuts: false }
}
