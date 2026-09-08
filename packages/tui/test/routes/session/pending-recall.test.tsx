import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { TextareaRenderable } from "@opentui/core"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { tmpdir } from "../../fixture/fixture"

let sessionCounter = 0

function pendingItem(sessionID: string, id: string, text: string) {
  return { id, sessionID, timeCreated: 0, type: "user", delivery: "steer", payload: { text } }
}

async function withPendingSession(
  texts: string[],
  assertions: (harness: {
    setup: Awaited<ReturnType<typeof createTestRenderer>>
    cancelled: string[]
    composer: () => TextareaRenderable
  }) => Promise<void>,
) {
  // A fresh session id per test: the draft stash is module state shared across tests.
  const sessionID = `ses_pending_recall_${sessionCounter++}`
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const events = createEventStream()
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const cancelled: string[] = []
  let inbox = texts.map((text, index) => pendingItem(sessionID, `inbox_${index}`, text))

  const calls = createFetch(async (url, request) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "project",
          title: "Pending recall fixture",
          agent: "build",
          model: { providerID: "demo", id: "model" },
          location: { directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/inbox`) return json({ data: inbox })
    if (url.pathname.startsWith(`/api/session/${sessionID}/inbox/`) && request.method === "DELETE") {
      const inboxID = url.pathname.split("/").pop()!
      cancelled.push(inboxID)
      inbox = inbox.filter((item) => item.id !== inboxID)
      // The contract is 204 No Content; anything else surfaces as a failed cancel.
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/api/agent")
      return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
    if (url.pathname === "/api/model")
      return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
    return undefined
  }, events)

  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../../../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({ animations: false }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: { sessionID },
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )

  try {
    await ready.promise
    await setup.waitForFrame((frame) => frame.includes("Demo Model"))
    await setup.waitForFrame((frame) => frame.includes(texts[0]!))
    await assertions({
      setup,
      cancelled,
      composer: () => {
        const focused = setup.renderer.currentFocusedRenderable
        expect(focused).toBeInstanceOf(TextareaRenderable)
        return focused as TextareaRenderable
      },
    })
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}

async function waitForCancels(setup: Awaited<ReturnType<typeof createTestRenderer>>, cancelled: string[], n: number) {
  const deadline = Date.now() + 5000
  while (cancelled.length < n && Date.now() < deadline) {
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  await setup.renderOnce()
}

test("up arrow retracts every pending prompt into the composer, oldest first", async () => {
  await withPendingSession(["first pending", "second pending"], async ({ setup, cancelled, composer }) => {
    setup.mockInput.pressArrow("up")
    await waitForCancels(setup, cancelled, 2)

    expect(cancelled).toEqual(["inbox_0", "inbox_1"])
    expect(composer().plainText).toBe("first pending\nsecond pending")
  })
})

test("retracted prompts land ahead of text already typed", async () => {
  await withPendingSession(["pending one"], async ({ setup, cancelled, composer }) => {
    await setup.mockInput.typeText("my draft")
    await setup.renderOnce()
    expect(composer().plainText).toBe("my draft")

    // The cursor sits at the end of the draft, so the first press only moves to the first line.
    setup.mockInput.pressArrow("up")
    await setup.renderOnce()
    expect(cancelled).toEqual([])

    setup.mockInput.pressArrow("up")
    await waitForCancels(setup, cancelled, 1)

    expect(cancelled).toEqual(["inbox_0"])
    expect(composer().plainText).toBe("pending one\nmy draft")
  })
})
