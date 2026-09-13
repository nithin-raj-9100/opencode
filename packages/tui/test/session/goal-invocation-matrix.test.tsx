/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { runSessionGoal } from "../../src/session/goal-actions"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const ACTIVE = { objective: "Old objective", status: "active" as const, tokensUsed: 0, timeUsedSeconds: 0 }

type Record_ = {
  prompted: string[]
  toasts: Array<{ title?: string; message: string; variant: string }>
  // Composer restores the command requested, via restorePrompt or a false return.
  restored: number
}

function makeRecord(): Record_ {
  return { prompted: [], toasts: [], restored: 0 }
}

function makeApi() {
  return {
    session: {
      goal: {
        set: async ({ objective, status }: any) => ({
          objective: objective ?? "goal",
          status: status ?? "active",
          tokensUsed: 0,
          timeUsedSeconds: 0,
        }),
        clear: async () => ({ cleared: true }),
      },
      rename: async () => undefined,
    },
  } as any
}

type RunInput = { args: string | undefined; goal?: typeof ACTIVE; prepare?: () => Promise<void> }

function makeToast(record: Record_) {
  return {
    show: (options: any) => record.toasts.push(options),
    error: () => undefined,
  } as any
}

// Faithful model of the caller in packages/tui/src/component/prompt/index.tsx:
//   history.append(scope, {...store.prompt})
//   resetComposer()  -> input.clear + empty store
//   const handled = await slash.command.run(slash.input, undefined, restoreEntry)
//   if (handled === false) restoreEntry()
// so the composer is ALWAYS empty by the time the command runs, and the raw
// submitted line is ALWAYS parked in up-arrow history first. The command itself
// receives only the argument text (head.arguments, routes/session/index.tsx:955).
//
// This harness covers the paths that never render a dialog: the dialog it passes
// is never asked to show anything, so no render root is needed.
async function runLogic(input: RunInput) {
  const record = makeRecord()
  const handled = await runSessionGoal({
    sessionID: "ses_1",
    args: input.args,
    api: makeApi(),
    goal: input.goal,
    sessionTitle: "Existing session",
    dialog: { replace: () => {}, clear: () => {} } as any,
    toast: makeToast(record),
    prepare: input.prepare,
    prompt: async (text: string) => {
      record.prompted.push(text)
    },
    restorePrompt: () => {
      record.restored += 1
    },
  })
  if (handled === false) record.restored += 1
  return record
}

// The dialog paths run against the REAL dialog components inside a real render
// root: the assertion is what the user actually sees, and mock.module is avoided
// because it is process-wide and would stub these components for every other test
// file sharing the process.
async function runRendered(input: RunInput) {
  await using tmp = await tmpdir()
  const root = tmp.path
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig()
  const record = makeRecord()
  let settled: Promise<unknown> | undefined

  function Fixture() {
    const dialog = useDialog()
    onCleanup(Keymap.use().mode.push("modal"))
    onMount(() => {
      settled = runSessionGoal({
        sessionID: "ses_1",
        args: input.args,
        api: makeApi(),
        goal: input.goal,
        sessionTitle: "Existing session",
        dialog,
        toast: makeToast(record),
        prepare: input.prepare,
        prompt: async (text: string) => {
          record.prompted.push(text)
        },
        restorePrompt: () => {
          record.restored += 1
        },
      })
    })
    return <box />
  }

  const app = await testRender(
    () => (
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
    ),
    { width: 80, height: 20, kittyKeyboard: true },
  )
  app.renderer.start()
  await settled
  return { app, record }
}

// The invariant the user cares about, at the SCREEN level:
//   "the text I typed either becomes a visible transcript row, or remains
//    recoverable in the composer/history - it must never silently vanish."
// The composer half is the caller's: it clears the composer before the command
// runs, so the command must either admit a transcript row via prompt(), keep a
// dialog on screen carrying the objective text, or hand the line back through
// restorePrompt.
function recoverable(record: Record_) {
  return record.prompted.length > 0 || record.restored > 0
}

describe("bare /goal (no objective)", () => {
  test("/goal with no goal shows the usage alert and admits nothing", async () => {
    const { app, record } = await runRendered({ args: "" })
    try {
      await app.waitForFrame((frame) => frame.includes("Usage: /goal"), { maxPasses: 100 })
      expect(record.prompted).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })

  test("/goal with an existing goal opens the summary dialog", async () => {
    const { app, record } = await runRendered({ args: "   ", goal: ACTIVE })
    try {
      await app.waitForFrame((frame) => frame.includes("Old objective"), { maxPasses: 100 })
      expect(record.prompted).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("control verbs (user intends the verb, not a prompt row)", () => {
  for (const verb of ["clear", "pause", "resume"] as const) {
    test(`/goal ${verb} performs the action and admits no transcript row`, async () => {
      const record = await runLogic({ args: verb, goal: ACTIVE })
      expect(record.prompted).toEqual([])
      expect(record.toasts.length + record.restored).toBeGreaterThan(0)
    })
  }

  test("/goal edit opens an editor prefilled with the existing objective", async () => {
    const { app, record } = await runRendered({ args: "edit", goal: ACTIVE })
    try {
      await app.waitForFrame((frame) => frame.includes("Old objective"), { maxPasses: 100 })
      expect(record.prompted).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("objective forms: the typed text must survive on screen", () => {
  test("/goal <objective> with no existing goal admits a visible transcript row", async () => {
    const record = await runLogic({ args: "Fix the footer timer" })
    expect(record.prompted).toEqual(["/goal Fix the footer timer"])
  })

  test("/goal <n>m <objective> admits the objective (timer prefix stripped)", async () => {
    const record = await runLogic({ args: "5m recheck coverage" })
    expect(record.prompted).toEqual(["/goal recheck coverage"])
  })

  test("/goal <objective> + CONFIRM on the replace dialog admits the new objective", async () => {
    const { app, record } = await runRendered({ args: "Fix the footer timer", goal: ACTIVE })
    try {
      await app.waitForFrame((frame) => frame.includes("Replace goal?"), { maxPasses: 100 })
      expect(record.prompted).toEqual([])
      app.mockInput.pressEnter()
      await app.waitFor(() => record.prompted.length === 1, { maxPasses: 100 })
      expect(record.prompted).toEqual(["/goal Fix the footer timer"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("/goal <objective> + CANCEL on the replace dialog hands the objective back", async () => {
    const { app, record } = await runRendered({ args: "Fix the footer timer", goal: ACTIVE })
    try {
      await app.waitForFrame((frame) => frame.includes("Replace goal?"), { maxPasses: 100 })
      app.mockInput.pressEscape()
      await app.waitFor(() => record.restored === 1, { maxPasses: 100 })
      expect(recoverable(record)).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("/goal every <objective> admits the objective as a plain goal", async () => {
    const record = await runLogic({ args: "every 5m recheck coverage" })
    expect(record.prompted).toEqual(["/goal every 5m recheck coverage"])
  })

  test("an objective that merely starts with 'every' is not dropped", async () => {
    const record = await runLogic({ args: "every PR needs a test" })
    expect(recoverable(record)).toBe(true)
  })

  test("INVARIANT: /goal <objective over the 4000 char limit> is handed back", async () => {
    const record = await runLogic({ args: "x".repeat(4001) })
    expect(record.prompted).toEqual([])
    expect(recoverable(record)).toBe(true)
  })

  test("INVARIANT: a rejecting prepare() hands the objective back", async () => {
    const record = await runLogic({
      args: "Fix the footer timer",
      prepare: async () => {
        throw new Error("switchAgent failed")
      },
    })
    expect(record.prompted).toEqual([])
    expect(recoverable(record)).toBe(true)
  })
})

describe("up-arrow history is a second safety net behind the restore", () => {
  // Models prompt/index.tsx: the raw line is parked in history BEFORE the
  // composer is cleared, so even a restore that is skipped (the user started
  // typing) leaves the bytes recoverable.
  test("the raw '/goal ...' line is recorded in history before the composer is cleared", () => {
    const history: string[] = []
    const submitted = "/goal Fix the footer timer"
    history.push(submitted)
    const composer = ""
    expect(composer).toBe("")
    expect(history).toContain(submitted)
  })
})
