/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createRoot, createSignal } from "solid-js"
import type { SessionMessageInfo } from "@opencode/client"
import { ConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import {
  createPromptIndex,
  PromptNavigator,
  promptNavigationIndex,
  viewedPromptNumber,
} from "../../../src/routes/session/prompt-navigator"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("prompt navigation moves exactly one prompt in either direction", () => {
  expect(promptNavigationIndex(3, 3, "prev")).toBe(1)
  expect(promptNavigationIndex(2, 3, "prev")).toBe(0)
  expect(promptNavigationIndex(1, 3, "prev")).toBe(0)
  expect(promptNavigationIndex(1, 3, "next")).toBe(1)
  expect(promptNavigationIndex(2, 3, "next")).toBe(2)
  expect(promptNavigationIndex(3, 3, "next")).toBe(2)
  expect(promptNavigationIndex(0, 0, "prev")).toBeUndefined()
})

test("prompt arrows consume mouse selection events above transcript text", async () => {
  const [current, setCurrent] = createSignal(2)
  const previous: number[] = []
  const next: number[] = []
  const parent = { down: 0, up: 0 }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <box
              width="100%"
              height="100%"
              position="relative"
              onMouseDown={() => parent.down++}
              onMouseUp={() => parent.up++}
            >
              <text position="absolute" top={0} right={0}>
                selectable transcript text directly below arrows
              </text>
              <PromptNavigator
                current={current()}
                total={2}
                onPrevious={() => {
                  previous.push(current())
                  setCurrent(1)
                }}
                onNext={() => {
                  next.push(current())
                  setCurrent(2)
                }}
              />
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 64, height: 3 },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("↑ 2 of 2 ↓"))
    const up = app.captureCharFrame().split("\n")[0]!.indexOf("↑")
    await app.mockMouse.click(up, 0)
    await app.waitForFrame((frame) => frame.includes("↑ 1 of 2 ↓"))
    expect(previous).toEqual([2])
    expect(parent).toEqual({ down: 0, up: 0 })
    expect(app.renderer.getSelection()).toBeNull()

    const down = app.captureCharFrame().split("\n")[0]!.indexOf("↓")
    await app.mockMouse.click(down, 0)
    await app.waitForFrame((frame) => frame.includes("↑ 2 of 2 ↓"))
    expect(next).toEqual([1])
    expect(parent).toEqual({ down: 0, up: 0 })
    expect(app.renderer.getSelection()).toBeNull()
  } finally {
    app.renderer.destroy()
  }
})

const model = { providerID: "fixture", id: "fixture" }
const user = (id: string): SessionMessageInfo => ({ type: "user", id, text: id, time: { created: 0 } })
const answer = (id: string): SessionMessageInfo => ({
  type: "assistant",
  id,
  agent: "build",
  model,
  finish: "stop",
  time: { created: 0, completed: 0 },
  content: [{ type: "text", text: id }],
})

test("prompt index counts prompts outside the loaded transcript window", async () => {
  const pages: Record<string, { data: { id: string }[]; cursor: { next?: string | null } }> = {
    first: { data: [{ id: "u1" }, { id: "u2" }], cursor: { next: "second" } },
    second: { data: [{ id: "u3" }, { id: "u4" }], cursor: { next: null } },
  }
  const [messages, setMessages] = createSignal<readonly SessionMessageInfo[]>([user("u4"), answer("a4")])
  const requests: (string | undefined)[] = []
  const settled = Promise.withResolvers<void>()
  const { prompts, dispose } = createRoot((dispose) => ({
    dispose,
    prompts: createPromptIndex({
      sessionID: () => "ses",
      connected: () => true,
      messages,
      list: async (query) => {
        requests.push(query.cursor)
        const page = pages[query.cursor ?? "first"]!
        if (!page.cursor.next) queueMicrotask(settled.resolve)
        return page
      },
    }),
  }))

  try {
    expect(prompts()).toEqual(["u4"])
    await settled.promise
    expect(prompts()).toEqual(["u1", "u2", "u3", "u4"])
    expect(requests).toEqual([undefined, "second"])

    // A live prompt merges locally without another index read.
    setMessages([user("u4"), answer("a4"), user("u5")])
    expect(prompts()).toEqual(["u1", "u2", "u3", "u4", "u5"])
    expect(requests).toEqual([undefined, "second"])

    // A prompt leaving the store re-reads the index from the server.
    setMessages([user("u4"), answer("a4")])
    expect(requests).toEqual([undefined, "second", undefined])
  } finally {
    dispose()
  }
})

test("viewed prompt resolves the turn at the top of the viewport", () => {
  const prompts = ["u1", "u2", "u3", "u4", "u5"]
  // Only the newest turns are loaded: u4's answer tail is older context, then u4 and u5.
  const messages = [answer("a3"), user("u4"), answer("a4"), user("u5"), answer("a5")]
  const positions = [
    { id: "a3", y: 0 },
    { id: "u4", y: 10 },
    { id: "a4", y: 12 },
    { id: "u5", y: 30 },
    { id: "a5", y: 32 },
  ]
  const viewed = (top: number) => viewedPromptNumber({ prompts, messages, positions, top })

  expect(viewed(0)).toBe(3)
  expect(viewed(10)).toBe(4)
  expect(viewed(20)).toBe(4)
  expect(viewed(31)).toBe(5)
  expect(viewedPromptNumber({ prompts, messages, positions: [], top: 0 })).toBe(5)
  expect(viewedPromptNumber({ prompts: [], messages, positions, top: 0 })).toBe(0)
})
