/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("useCommands run forwards a false result", async () => {
  let find: (id: string) => any = () => undefined

  function Harness() {
    Keymap.createLayer(() => ({
      commands: [
        { id: "test.refuse", run() { return false } },
        { id: "test.async.refuse", async run() { return false } },
        { id: "test.restore", run(_input: string | undefined, _e: unknown, restore?: () => void) { restore?.(); return false } },
      ],
    }))
    const commands = Keymap.useCommands()
    find = (id) => commands().find((c) => c.id === id)
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    const sync = await find("test.refuse").run("x", undefined, () => {})
    const asyncRun = await find("test.async.refuse").run("x", undefined, () => {})
    let restored = false
    const restoreCase = await find("test.restore").run("x", undefined, () => { restored = true })
    // eslint-disable-next-line no-console
    console.log("RESULT", JSON.stringify({ sync, asyncRun, restoreCase, restored }))
    expect(sync).toBe(false)
    expect(asyncRun).toBe(false)
    expect(restoreCase).toBe(false)
    expect(restored).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
