import { useRenderer } from "@opentui/solid"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { useNewDesigns } from "../config"
import { DialogButtons, DialogHeader, DialogLayout, useDialog } from "./dialog"
import { createStore } from "solid-js/store"
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

const keys = ["cancel", "confirm"] as const

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

  const toggle = () => setStore("active", store.active === "confirm" ? "cancel" : "confirm")

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: newDesigns()
      ? [
          { bind: "return", title: "Confirm", group: "Dialog", run: () => choose("confirm") },
          { bind: "escape", title: "Cancel dialog", group: "Dialog", run: dismiss },
        ]
      : [
          { bind: "return", title: "Confirm dialog selection", group: "Dialog", run: () => choose(store.active) },
          { bind: "left", title: "Previous dialog option", group: "Dialog", run: toggle },
          { bind: "right", title: "Next dialog option", group: "Dialog", run: toggle },
          { bind: "tab", title: "Next dialog option", group: "Dialog", run: toggle },
          { bind: "shift+tab", title: "Previous dialog option", group: "Dialog", run: toggle },
          { bind: "escape", title: "Cancel dialog", group: "Dialog", run: dismiss },
        ],
  }))
  return (
    <DialogLayout
      header={<DialogHeader title={props.title} onClose={() => choose("cancel")} />}
      buttons={
        <DialogButtons
          buttons={keys.map((key) => ({ label: Locale.titlecase(props.label?.[key] ?? key), run: () => choose(key) }))}
          active={keys.indexOf(store.active)}
          onActive={(index) => setStore("active", keys[index]!)}
        />
      }
    >
      <text fg={theme.text.muted}>{props.message}</text>
    </DialogLayout>
  )
}
