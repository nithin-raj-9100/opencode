import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInfo } from "../src/promise"

const SESSION = "ses_stale2"
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

test("both echoes lost: pending + row pinned after revert", async () => {
  const setup = harness()
  try {
    setup.data.session.remember(session())
    await setup.data.session.prompt({ sessionID: SESSION, text: "hi" })
    const id = setup.data.session.message.list(SESSION).find((m) => m.type === "user")?.id as string
    // no enqueued, no delivered: both echoes lost during the gap
    setup.emit({ id: "e2", created: 3, type: "session.revert.committed", durable: durable(2), data: { sessionID: SESSION, to: id } })
    console.log("pending pinned:", setup.data.session.input.has(SESSION, id))
    console.log("row pinned:", setup.data.session.message.list(SESSION).some((m) => m.id === id))
  } finally { setup.dispose() }
})
