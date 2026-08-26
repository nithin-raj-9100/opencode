/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { resolve, TuiConfigProvider } from "../src/config"
import { KVProvider } from "../src/context/kv"
import { ThemeProvider } from "../src/context/theme"
import { PromptNavigator } from "../src/routes/session/prompt-navigator"
import { TestTuiContexts } from "./fixture/tui-environment"

async function renderOnceSettled(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  await new Promise((r) => setTimeout(r, 60))
  await app.renderOnce()
}

function getTextStrings(node: any): string[] {
  const result: string[] = []
  if (node.rootTextNode?.children) {
    for (const child of node.rootTextNode.children) {
      if (Array.isArray(child._children)) {
        for (const str of child._children) {
          if (typeof str === "string") result.push(str)
        }
      }
    }
  }
  if (typeof node.getChildren === "function") {
    for (const child of node.getChildren()) {
      result.push(...getTextStrings(child))
    }
  }
  return result
}

function findBoxes(renderable: any): any[] {
  const result: any[] = []
  if (typeof renderable.getChildren === "function") {
    for (const child of renderable.getChildren()) {
      result.push(child, ...findBoxes(child))
    }
  }
  return result
}

describe("PromptNavigator", () => {
  const config = resolve({}, { terminalSuspend: true })

  test("does not render when total is 0", async () => {
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <box width={80} height={10}>
                  <PromptNavigator
                    total={() => 0}
                    current={() => 1}
                    showScrollbar={() => false}
                    onNavigate={() => {}}
                  />
                </box>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 10 },
    )

    try {
      await renderOnceSettled(app)
      const texts = getTextStrings(app.renderer.root)
      expect(texts.some((t) => t.includes("of"))).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders prompt counter and arrows when total > 0", async () => {
    const [current, setCurrent] = createSignal(2)
    const [total, setTotal] = createSignal(3)

    const app = await testRender(
      () => (
        <TestTuiContexts>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <box width={80} height={10}>
                  <PromptNavigator
                    total={total}
                    current={current}
                    showScrollbar={() => false}
                    onNavigate={() => {}}
                  />
                </box>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 10 },
    )

    try {
      await renderOnceSettled(app)
      const texts = getTextStrings(app.renderer.root)
      expect(texts).toContain("2 of 3")
      expect(texts).toContain("↑")
      expect(texts).toContain("↓")
    } finally {
      app.renderer.destroy()
    }
  })

  test("dispatches onNavigate with correct directions on mouseUp", async () => {
    const calls: string[] = []

    const app = await testRender(
      () => (
        <TestTuiContexts>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <box width={80} height={10}>
                  <PromptNavigator
                    total={() => 3}
                    current={() => 2}
                    showScrollbar={() => false}
                    onNavigate={(dir) => calls.push(dir)}
                  />
                </box>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 10 },
    )

    try {
      await renderOnceSettled(app)
      const boxes = findBoxes(app.renderer.root)
      for (const box of boxes) {
        if (typeof box._mouseListeners?.up === "function") {
          const texts = getTextStrings(box)
          if (texts.includes("↑")) {
            box._mouseListeners.up({ type: "up" })
          }
          if (texts.includes("↓")) {
            box._mouseListeners.up({ type: "up" })
          }
        }
      }
      expect(calls).toEqual(["prev", "next"])
    } finally {
      app.renderer.destroy()
    }
  })
})
