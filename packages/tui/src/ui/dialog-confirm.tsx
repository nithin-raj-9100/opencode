import { useRenderer } from "@opentui/solid"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { useNewDesigns } from "../config"
import { DialogHeader, DialogLayout, useDialog } from "./dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { Locale } from "../util/locale"

export type DialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
  label?: {
    confirm?: string
    cancel?: string
  }
}

export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const newDesigns = useNewDesigns()
  const renderer = useRenderer()
  const [store, setStore] = createStore({
    active: "confirm" as "confirm" | "cancel",
  })

  const choose = (key: "confirm" | "cancel") => {
    if (key === "confirm") props.onConfirm?.()
    if (key === "cancel") props.onCancel?.()
    dialog.clear()
  }

  const dismiss = () => {
    // Escape dismisses a text selection before it dismisses the dialog, matching
    // dialog-prompt/dialog-select/the provider's own escape layer. Without this the
    // first Escape after a copy-on-select drag cancels the dialog instead.
    if (renderer.getSelection()) {
      renderer.clearSelection()
      return
    }
    choose("cancel")
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: newDesigns()
      ? [
          { bind: "return", title: "Confirm", group: "Dialog", run: () => choose("confirm") },
          { bind: "escape", title: "Cancel dialog", group: "Dialog", run: dismiss },
        ]
      : [
          {
            bind: "return",
            title: "Confirm dialog selection",
            group: "Dialog",
            run: () => choose(store.active),
          },
          {
            bind: "left",
            title: "Previous dialog option",
            group: "Dialog",
            run: () => {
              setStore("active", store.active === "confirm" ? "cancel" : "confirm")
            },
          },
          {
            bind: "right",
            title: "Next dialog option",
            group: "Dialog",
            run: () => {
              setStore("active", store.active === "confirm" ? "cancel" : "confirm")
            },
          },
          { bind: "escape", title: "Cancel dialog", group: "Dialog", run: dismiss },
        ],
  }))
  return (
    <DialogLayout
      header={<DialogHeader title={props.title} onClose={() => choose("cancel")} />}
      footer={{
        actions: {
          primary: [
            // Footer labels are lowercase; the legacy buttons title-case the same labels.
            { title: (props.label?.cancel ?? "cancel").toLowerCase(), key: "esc", onTrigger: () => choose("cancel") },
            {
              title: (props.label?.confirm ?? "confirm").toLowerCase(),
              key: "enter",
              onTrigger: () => choose("confirm"),
            },
          ],
        },
      }}
      legacyFooter={
        <box flexDirection="row" justifyContent="flex-end">
          <For each={["cancel", "confirm"] as const}>
            {(key) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={key === store.active ? theme.background.action.primary.focused : undefined}
                onMouseUp={() => choose(key)}
              >
                <text fg={key === store.active ? theme.text.action.primary.focused : theme.text.muted}>
                  {Locale.titlecase(props.label?.[key] ?? key)}
                </text>
              </box>
            )}
          </For>
        </box>
      }
    >
      <text fg={theme.text.muted}>{props.message}</text>
    </DialogLayout>
  )
}
