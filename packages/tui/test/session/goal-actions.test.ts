import { expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client"
import type { DialogContext } from "../../src/ui/dialog"
import { runSessionGoal } from "../../src/session/goal-actions"

function toast() {
  const shown: Array<{ title?: string; message: string }> = []
  return {
    shown,
    show: (options: { title?: string; message: string; variant: "info" | "success" | "warning" | "error" }) => {
      shown.push(options)
    },
    error: () => undefined,
  }
}

test("admits the submitted /goal objective as a visible session prompt", async () => {
  const prompted: string[] = []
  const notices = toast()
  await runSessionGoal({
    sessionID: "ses_1",
    args: "Fix the footer timer",
    api: {
      session: {
        goal: {
          set: async () => ({
            objective: "Fix the footer timer",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
          }),
        },
      },
    } as unknown as OpenCodeClient,
    goal: undefined,
    sessionTitle: "Existing",
    dialog: { replace: () => undefined } as unknown as DialogContext,
    toast: notices,
    prompt: async (text) => {
      prompted.push(text)
    },
  })
  expect(prompted).toEqual(["/goal Fix the footer timer"])
  expect(notices.shown[0]?.title).toBe("Goal active")
})

test("does not admit control verbs as session prompts", async () => {
  const prompted: string[] = []
  await runSessionGoal({
    sessionID: "ses_1",
    args: "pause",
    api: {
      session: {
        goal: {
          set: async () => ({
            objective: "Fix the footer timer",
            status: "paused",
            tokensUsed: 0,
            timeUsedSeconds: 0,
          }),
        },
      },
    } as unknown as OpenCodeClient,
    goal: { objective: "Fix the footer timer", status: "active", tokensUsed: 0, timeUsedSeconds: 0 },
    sessionTitle: "Existing",
    dialog: { replace: () => undefined } as unknown as DialogContext,
    toast: toast(),
    prompt: async (text) => {
      prompted.push(text)
    },
  })
  expect(prompted).toEqual([])
})
