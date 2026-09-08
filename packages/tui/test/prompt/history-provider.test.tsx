/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { TuiPathsProvider } from "../../src/context/runtime"
import { PromptHistoryProvider, usePromptHistory } from "../../src/prompt/history"
import { tmpdir } from "../fixture/fixture"

const projectA = "/tmp/project-a"
const projectB = "/tmp/project-b"

const prompt = (text: string) => ({ text, files: [], agents: [], pasted: [] })

test("down rejects at the newest history item with an empty prompt", async () => {
  await using tmp = await tmpdir()
  const setup = await renderHistory(tmp.path)
  try {
    setup.history.append(projectA, prompt("previous"))

    expect(setup.history.move(projectA, 1, "")).toBeUndefined()
    expect(setup.history.move(projectA, -1, "")?.text).toBe("previous")
    expect(setup.history.move(projectA, 1, "previous")?.text).toBe("")
  } finally {
    setup.app.renderer.destroy()
  }
})

test("keeps prompt history separate per directory", async () => {
  await using tmp = await tmpdir()
  const setup = await renderHistory(tmp.path)
  try {
    setup.history.append(projectA, prompt("a-one"))
    setup.history.append(projectB, prompt("b-one"))
    setup.history.append(projectA, prompt("a-two"))

    // Directory A only recalls its own prompts, newest first.
    expect(setup.history.move(projectA, -1, "")?.text).toBe("a-two")
    expect(setup.history.move(projectA, -1, "a-two")?.text).toBe("a-one")
    expect(setup.history.move(projectA, -1, "a-one")).toBeUndefined()

    // Directory B is unaffected by A's entries and keeps its own cursor.
    expect(setup.history.move(projectB, -1, "")?.text).toBe("b-one")
    expect(setup.history.move(projectB, -1, "b-one")).toBeUndefined()
  } finally {
    setup.app.renderer.destroy()
  }
})

test("seeds each new directory from the legacy global history", async () => {
  await using tmp = await tmpdir()
  const legacy = JSON.stringify(prompt("legacy")) + "\n"
  const setup = await renderHistory(tmp.path, legacy)
  try {
    await setup.history.ensure(projectA)
    expect(setup.history.move(projectA, -1, "")?.text).toBe("legacy")
    expect(setup.history.move(projectA, 1, "legacy")?.text).toBe("")

    // A second, previously unseen directory is seeded from the same legacy file.
    await setup.history.ensure(projectB)
    expect(setup.history.move(projectB, -1, "")?.text).toBe("legacy")
  } finally {
    setup.app.renderer.destroy()
  }
})

test("scopes diverge after seeding", async () => {
  await using tmp = await tmpdir()
  const legacy = JSON.stringify(prompt("legacy")) + "\n"
  const setup = await renderHistory(tmp.path, legacy)
  try {
    await setup.history.ensure(projectA)
    await setup.history.ensure(projectB)
    setup.history.append(projectA, prompt("a-only"))

    expect(setup.history.move(projectA, -1, "")?.text).toBe("a-only")
    expect(setup.history.move(projectB, -1, "")?.text).toBe("legacy")
  } finally {
    setup.app.renderer.destroy()
  }
})

test("persists each directory to its own file", async () => {
  await using tmp = await tmpdir()
  const setup = await renderHistory(tmp.path)
  try {
    setup.history.append(projectA, prompt("a-one"))
    setup.history.append(projectB, prompt("b-one"))
    await Bun.sleep(20)

    const dir = path.join(tmp.path, "state", "prompt-history")
    const files = [...new Bun.Glob("*.jsonl").scanSync(dir)]
    expect(files).toHaveLength(2)

    const contents = await Promise.all(files.map((file) => Bun.file(path.join(dir, file)).text()))
    expect(contents.some((text) => text.includes("a-one") && !text.includes("b-one"))).toBe(true)
    expect(contents.some((text) => text.includes("b-one") && !text.includes("a-one"))).toBe(true)
  } finally {
    setup.app.renderer.destroy()
  }
})

async function renderHistory(root: string, persisted?: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  if (persisted) await Bun.write(path.join(state, "prompt-history.jsonl"), persisted)
  let history: ReturnType<typeof usePromptHistory>

  function Consumer() {
    history = usePromptHistory()
    return <box />
  }

  const app = await testRender(() => (
    <TuiPathsProvider value={{ cwd: root, home: root, state, worktree: root }}>
      <PromptHistoryProvider>
        <Consumer />
      </PromptHistoryProvider>
    </TuiPathsProvider>
  ))
  await app.renderOnce()
  return { app, history: history! }
}
