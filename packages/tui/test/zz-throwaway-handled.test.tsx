/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("throwaway: useCommands wrapper forwards false return", async () => {
  let read = () => undefined as unknown as ReturnType<() => readonly any[]>
  let restoreCalls: Array<() => void> = []

  function Harness() {
    Keymap.createLayer(() => ({
      commands: [
        {
          id: "throwaway.refuse",
          slash: { name: "refuse", arguments: true },
          run: (_input?: string, _event?: unknown, restore?: () => void) => {
            if (restore) restoreCalls.push(restore)
            return false as const
          },
        },
      ],
    }))
    const commands = Keymap.useCommands()
    read = () => commands()
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
    const commands = read()
    const entry = commands.find((c: any) => c.slash?.name === "refuse")
    expect(entry).toBeDefined()
    const restore = () => {}
    const result = await entry!.run("some input", undefined, restore)
    // eslint-disable-next-line no-console
    console.error("THROWAWAY handled result =", result, "restoreCalls =", restoreCalls.length)
    expect(restoreCalls.length).toBe(1)
    expect(result).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})
