// REGRESSION: the user's typed '/goal <objective>' row must survive a revert that the
// server commits while admitting it.
//
// The TUI slash path for '/goal ...' clears the composer and calls
// data.session.prompt({ sessionID, text, resume:false }) directly; it never commits a
// staged revert client-side (that commit lives only in the plain-prompt branch). The
// server therefore commits the staged revert while admitting the prompt
// (packages/core/src/session/session.ts:158-159), publishing session.revert.committed.
//
// The projector deletes messages and inbox items at or after the boundary *before* the
// new prompt is admitted (projector.ts RevertEvent.Committed), so the new item outlives
// the delete. The client used to mirror the delete literally: it spliced every row with
// id >= `to` and every pending item id >= `to`, destroying the local row for work the
// server was about to accept — the prompt vanished.
//
// This test drives the REAL store + reducer in packages/client/src/solid/data.ts:
//   1. the optimistic '/goal ...' user row is admitted (data.ts prompt wrapper)
//   2. session.revert.committed arrives; the row is still in the outbox (unacknowledged),
//      so it must be kept
//   3. the later session.inbox.delivered echo repositions it without dropping it
//
// A control store without the staged revert keeps the row, isolating the revert as the cause.

import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInfo } from "../src/promise"
import { SessionMessage } from "@opencode/schema/session-message"

const SESSION = "ses_goal"

const session = (): SessionInfo => ({
  id: SESSION,
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  outcome: "succeeded",
  time: { created: 0, updated: 0, idle: 2, viewed: 0 },
  location: { directory: "/project" },
})

const GOAL_TEXT = "/goal fix the footer timer"

function harness() {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === `/api/session/${SESSION}/prompt`) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id?: string }
        if (!body.id) throw new Error("prompt body missing id")
        return Response.json({
          data: {
            id: body.id,
            sessionID: SESSION,
            timeCreated: 1,
            type: "user",
            payload: { text: GOAL_TEXT },
            delivery: "steer",
          },
        })
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`)
    },
  })
  const event: CreateDataInput["event"] = {
    on: () => () => {},
    listen(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }),
    dispose,
  }))
  const emit = (details: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: details.type, details }))
  return { ...setup, emit }
}

const durable = (seq: number) => ({ aggregateID: SESSION, seq, version: seq })

test("'/goal <objective>' row admitted with the revert survives the committed revert and its echo", async () => {
  const setup = harness()
  try {
    setup.data.session.remember(session())

    // An existing (older) message that a pending revert points at (from /undo or
    // Message Actions Revert). Minted first so its ULID sorts below the new row.
    const boundary = SessionMessage.ID.create()

    // (1) The goal slash command's prompt callback: data.session.prompt({resume:false}).
    // The optimistic user row IS admitted under a client-minted ULID above the boundary.
    await setup.data.session.prompt({ sessionID: SESSION, text: GOAL_TEXT, resume: false })
    const admitted = setup.data.session.message.list(SESSION)
    const goalRowID = admitted.find((message) => message.type === "user")?.id
    expect(goalRowID).toBeDefined()

    // (2) A revert was staged at that older message, and the server commits it while
    // admitting the prompt (session.ts:158-159). The server admits the new item after
    // the commit, so its inbox row outlives the boundary delete.
    setup.emit({
      id: "evt_revert_staged",
      created: 2,
      type: "session.revert.staged",
      durable: durable(1),
      data: { sessionID: SESSION, revert: { messageID: boundary } },
    })
    setup.emit({
      id: "evt_revert_committed",
      created: 3,
      type: "session.revert.committed",
      durable: durable(2),
      data: { sessionID: SESSION, to: boundary },
    })

    const visible = () => setup.data.session.message.list(SESSION).some((message) => message.id === goalRowID)
    expect(visible()).toBe(true)
    expect(setup.data.session.input.has(SESSION, goalRowID as string)).toBe(true)

    // (3) The durable promotion echo arrives (GoalUpdated -> wake -> promote -> InboxDelivered).
    setup.emit({
      id: "evt_inbox_delivered",
      created: 4,
      type: "session.inbox.delivered",
      durable: durable(3),
      data: { sessionID: SESSION, inboxID: goalRowID as string },
    })

    expect(visible()).toBe(true)
  } finally {
    setup.dispose()
  }
})

test("control: without the committed revert, the '/goal <objective>' row survives the delivered echo", async () => {
  const setup = harness()
  try {
    setup.data.session.remember(session())
    await setup.data.session.prompt({ sessionID: SESSION, text: GOAL_TEXT, resume: false })
    const goalRowID = setup.data.session.message.list(SESSION).find((message) => message.type === "user")?.id
    expect(goalRowID).toBeDefined()

    setup.emit({
      id: "evt_inbox_delivered",
      created: 4,
      type: "session.inbox.delivered",
      durable: durable(1),
      data: { sessionID: SESSION, inboxID: goalRowID as string },
    })

    expect(setup.data.session.message.list(SESSION).some((message) => message.id === goalRowID)).toBe(true)
  } finally {
    setup.dispose()
  }
})

test("session.revert.committed removes a reverted row that sits ahead of a delivered tail row", async () => {
  const setup = harness()
  try {
    setup.data.session.remember(session())

    // A prompt row minted first, then an assistant row minted after it, so the
    // assistant's ULID sorts above the prompt's.
    await setup.data.session.prompt({ sessionID: SESSION, text: GOAL_TEXT, resume: false })
    const promptRow = setup.data.session.message.list(SESSION).find((message) => message.type === "user")?.id
    expect(promptRow).toBeDefined()
    const assistantID = SessionMessage.ID.create()
    expect(assistantID > (promptRow as string)).toBe(true)

    setup.emit({
      id: "evt_step_started",
      created: 2,
      type: "session.step.started",
      durable: durable(1),
      data: { sessionID: SESSION, assistantMessageID: assistantID, agent: "build", model: { providerID: "p", id: "m" } },
    })
    expect(setup.data.session.message.list(SESSION).map((message) => message.id)).toEqual([promptRow, assistantID])

    // Promotion moves the prompt row to the tail, so the transcript is no longer
    // sorted by id: [assistantID, promptRow].
    setup.emit({
      id: "evt_inbox_delivered",
      created: 3,
      type: "session.inbox.delivered",
      durable: durable(2),
      data: { sessionID: SESSION, inboxID: promptRow as string },
    })
    expect(setup.data.session.message.list(SESSION).map((message) => message.id)).toEqual([assistantID, promptRow])

    // The revert boundary is the assistant row: the server deleted it, and the
    // prompt row below the boundary must survive.
    setup.emit({
      id: "evt_revert_committed",
      created: 4,
      type: "session.revert.committed",
      durable: durable(3),
      data: { sessionID: SESSION, to: assistantID },
    })
    expect(setup.data.session.message.list(SESSION).map((message) => message.id)).toEqual([promptRow])
  } finally {
    setup.dispose()
  }
})
