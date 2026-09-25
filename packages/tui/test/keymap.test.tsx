/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("legacy page key aliases compile as page keys", async () => {
  let read = () => ({ up: "", down: "" })

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: [
        { id: "session.page.up", run() {} },
        { id: "session.page.down", run() {} },
      ],
    }))
    read = () => ({
      up: shortcuts.get("session.page.up") ?? "",
      down: shortcuts.get("session.page.down") ?? "",
    })
    return <box />
  }

  const app = await testRender(() => (
    <ConfigProvider
      config={createTuiResolvedConfig({
        keybinds: {
          "session.page.up": "pgup",
          "session.page.down": "pgdown",
        },
      })}
    >
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    expect(read()).toEqual({ up: "pgup", down: "pgdn" })
  } finally {
    app.renderer.destroy()
  }
})

test("formats navigation keys as arrows", async () => {
  let read = () => ({}) as Record<string, string>
  const commands = ["session.parent", "session.child.first"]

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: commands.map((id) => ({ id, run() {} })),
    }))
    read = () => Object.fromEntries(commands.map((id) => [id, shortcuts.get(id) ?? ""]))
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
    expect(read()).toEqual({
      "session.parent": "↑",
      "session.child.first": "↓",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("returns every formatted command shortcut", async () => {
  let read = () => [] as readonly string[]

  function Harness() {
    const shortcuts = Keymap.useShortcuts()
    Keymap.createLayer(() => ({
      commands: [{ id: "demo.command", bind: "x,y", run() {} }],
    }))
    read = () => shortcuts.list("demo.command")
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
    expect(read()).toEqual(["x", "y"])
  } finally {
    app.renderer.destroy()
  }
})

test("global commands stay reachable when the mode changes", async () => {
  const calls: string[] = []
  let exercise = () => {}

  function Harness() {
    const keymap = Keymap.use()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [{ id: "session.list", run: () => void calls.push("global") }],
    }))
    Keymap.createLayer(() => ({
      commands: [{ id: "model.list", run: () => void calls.push("base") }],
    }))

    exercise = () => {
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      const pop = keymap.mode.push("question")
      keymap.dispatch("session.list")
      keymap.dispatch("model.list")
      pop()
    }
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
    exercise()
    expect(calls).toEqual(["global", "base", "global"])
  } finally {
    app.renderer.destroy()
  }
})

test("a slash command's run receives the composer restore callback", async () => {
  const calls: Array<{ input: string | undefined; restore: (() => void) | undefined }> = []
  let invoke: (() => void) | undefined

  function Harness() {
    const commands = Keymap.useCommands()
    Keymap.createLayer(() => ({
      commands: [
        {
          id: "test.restore",
          slash: { name: "restore", arguments: true as const },
          run: (input?: string, _event?: unknown, restore?: () => void) => {
            calls.push({ input, restore })
          },
        },
      ],
    }))
    invoke = () => {
      const command = commands().find((command) => command.slash?.name === "restore")
      command?.run("payload", undefined, onRestore)
    }
    return <box />
  }

  const onRestore = () => {}
  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ))
  try {
    invoke!()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toBe("payload")
    expect(calls[0]!.restore).toBe(onRestore)
  } finally {
    app.renderer.destroy()
  }
})

test.each([false, true])("a slash command reports refusal and restores input (async: %s)", async (async) => {
  let refuse: (() => Promise<void | false>) | undefined
  const restored: string[] = []

  function Harness() {
    const commands = Keymap.useCommands()
    Keymap.createLayer(() => ({
      commands: [
        {
          id: "test.refuse",
          slash: { name: "refuse", arguments: true as const },
          run: (input, _event, restore) => {
            restored.push(input ?? "")
            restore?.()
            return async ? Promise.resolve(false as const) : false
          },
        },
      ],
    }))
    refuse = async () =>
      commands()
        .find((command) => command.slash?.name === "refuse")
        ?.run("payload", undefined, () => restored.push("restored"))
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
    expect(restored).toEqual(["payload", "restored"])
  } finally {
    app.renderer.destroy()
  }
})

test.each([false, true])("Down falls through only when prompt history declines (handled: %s)", async (handled) => {
  const calls: string[] = []

  function Harness() {
    Keymap.createLayer(() => ({
      commands: [{ id: "session.child.first", run: () => void calls.push("picker") }],
    }))
    Keymap.createLayer(() => ({
      priority: 1,
      commands: [
        {
          id: "prompt.history.next",
          run: () => {
            calls.push("history")
            if (!handled) return false
          },
        },
      ],
    }))
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
    app.mockInput.pressArrow("down")
    expect(calls).toEqual(handled ? ["history"] : ["history", "picker"])
  } finally {
    app.renderer.destroy()
  }
})
