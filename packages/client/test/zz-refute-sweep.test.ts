import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInfo } from "../src/promise"
import { SessionMessage } from "@opencode/schema/session-message"

const SESSION = "ses_refute"
const session = (): SessionInfo => ({
  id: SESSION, projectID: "project", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  outcome: "succeeded", time: { created: 0, updated: 0, idle: 2, viewed: 0 },
  location: { directory: "/project" },
})
function harness() {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === `/api/session/${SESSION}/prompt`) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id?: string }
        return Response.json({ data: { id: body.id, sessionID: SESSION, timeCreated: 1, type: "user", payload: { text: "hi" }, delivery: "steer" } })
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`)
    },
  })
  const event: CreateDataInput["event"] = { on: () => () => {}, listen(h) { listeners.add(h); return () => listeners.delete(h) } }
  const setup = createRoot((dispose) => ({ data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }), dispose }))
  const emit = (details: OpenCodeEvent) => listeners.forEach((l) => l({ name: details.type, details }))
  return { ...setup, emit }
}
const durable = (seq: number) => ({ aggregateID: SESSION, seq, version: seq })

test("revert to the small-id delivered row over-deletes the large-id row the server keeps", async () => {
  const setup = harness()
  try {
    setup.data.session.remember(session())
    await setup.data.session.prompt({ sessionID: SESSION, text: "steer", resume: false })
    const promptRow = setup.data.session.message.list(SESSION).find((m) => m.type === "user")?.id as string
    const assistantID = SessionMessage.ID.create()
    expect(assistantID > promptRow).toBe(true)

    // assistant row created (server seq 1), prompt row promoted to tail (server seq 2)
    setup.emit({ id: "e1", created: 2, type: "session.step.started", durable: durable(1), data: { sessionID: SESSION, assistantMessageID: assistantID, agent: "build", model: { providerID: "p", id: "m" } } })
    setup.emit({ id: "e2", created: 3, type: "session.inbox.delivered", durable: durable(2), data: { sessionID: SESSION, inboxID: promptRow } })
    expect(setup.data.session.message.list(SESSION).map((m) => m.id)).toEqual([assistantID, promptRow])

    // Server deletes seq >= promptRow.seq (2): only promptRow. assistant (seq 1) survives.
    setup.emit({ id: "e3", created: 4, type: "session.revert.committed", durable: durable(3), data: { sessionID: SESSION, to: promptRow } })
    const after = setup.data.session.message.list(SESSION).map((m) => m.id)
    console.log("AFTER REVERT:", JSON.stringify(after))
    console.log("assistant survived:", after.includes(assistantID))
  } finally { setup.dispose() }
})
