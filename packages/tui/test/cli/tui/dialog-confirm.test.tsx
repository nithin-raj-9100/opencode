/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { DialogConfirm } from "../../../src/ui/dialog-confirm"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function mountConfirm(root: string, onCancel: () => void) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig()

  function Harness() {
    function Fixture() {
      const dialog = useDialog()
      onCleanup(Keymap.use().mode.push("modal"))
      onMount(() =>
        dialog.replace(() => (
          <DialogConfirm
            title="Replace goal?"
            message="New objective: Fix the footer timer"
            label={{ confirm: "Replace", cancel: "Cancel" }}
            onCancel={onCancel}
          />
        )),
      )
      return <box />
    }

    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ConfigProvider config={config}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Fixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 20, kittyKeyboard: true })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Replace goal?"), { maxPasses: 100 })
  return app
}

test("escape invokes the cancel handler before dismissing", async () => {
  await using tmp = await tmpdir()
  let cancelled = 0
  const app = await mountConfirm(tmp.path, () => cancelled++)
  try {
    app.mockInput.pressEscape()
    await app.waitFor(() => cancelled === 1, { maxPasses: 100 })
    expect(cancelled).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("the esc label invokes the cancel handler", async () => {
  await using tmp = await tmpdir()
  let cancelled = 0
  const app = await mountConfirm(tmp.path, () => cancelled++)
  try {
    const frame = app.captureCharFrame().split("\n")
    const row = frame.findIndex((line) => line.includes("Replace goal?"))
    const column = frame[row]!.indexOf("esc")
    await app.mockMouse.click(column, row)
    await app.waitFor(() => cancelled === 1, { maxPasses: 100 })
    expect(cancelled).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("escape clears a text selection before cancelling the dialog", async () => {
  await using tmp = await tmpdir()
  let cancelled = 0
  const app = await mountConfirm(tmp.path, () => cancelled++)
  try {
    const frame = app.captureCharFrame().split("\n")
    const row = frame.findIndex((line) => line.includes("New objective"))
    const column = frame[row]!.indexOf("objective") + 1
    await app.mockMouse.click(column, row)
    await app.mockMouse.click(column, row)
    await app.waitFor(() => app.renderer.getSelection()?.getSelectedText() === "objective", { maxPasses: 100 })

    app.mockInput.pressEscape()
    await app.waitFor(() => !app.renderer.getSelection(), { maxPasses: 100 })
    expect(cancelled).toBe(0)
    expect(app.captureCharFrame()).toContain("Replace goal?")

    app.mockInput.pressEscape()
    await app.waitFor(() => cancelled === 1, { maxPasses: 100 })
  } finally {
    app.renderer.destroy()
  }
})
