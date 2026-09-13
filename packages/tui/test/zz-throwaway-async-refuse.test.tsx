/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("async false reports refusal through the useCommands wrapper", async () => {
  let refuse: (() => Promise<void | false>) | undefined
  function Harness() {
    const commands = Keymap.useCommands()
    Keymap.createLayer(() => ({
      commands: [
        {
          id: "test.async.refuse",
          slash: { name: "async-refuse", arguments: true as const },
          run: async () => { await Promise.resolve(); return false as const },
        },
      ],
    }))
    refuse = async () => commands().find((c) => c.slash?.name === "async-refuse")?.run("payload")
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
    expect(await refuse!()).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})
