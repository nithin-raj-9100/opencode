/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { PromptNavigator, promptNavigationIndex } from "../../../src/routes/session/prompt-navigator"
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
