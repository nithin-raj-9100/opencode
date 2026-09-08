import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import type { TuiInput } from "../../src/app"
import type { Config } from "../../src/config"
import path from "node:path"
import os from "node:os"
import { createEventStream, createFetch, type FetchHandler } from "./tui-client"

// Callers that do not pin a state directory would otherwise resolve Global to the
// user's real XDG state dir and write prompt history and other TUI state into it.
const fallbackState = path.join(os.tmpdir(), `opencode-tui-test-${process.pid}`)

export async function createAppFixture(
  input: {
    width?: number
    height?: number
    state?: string
    config?: Config.Info
    args?: TuiInput["args"]
    fetch?: FetchHandler
  } = {},
) {
  const { run } = await import("../../src/app")
  const setup = await createTestRenderer({
    width: input.width ?? 100,
    height: input.height ?? 30,
    useThread: false,
    kittyKeyboard: true,
  })
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const events = createEventStream()
  const calls = createFetch(input.fetch, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => input.config ?? { animations: false }, update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: input.args ?? {},
      log: () => {},
    }).pipe(
      Effect.provide(Global.layerWith({ state: input.state ?? fallbackState })),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  )
  return {
    ...setup,
    events,
    ready: ready.promise,
    async [Symbol.asyncDispose]() {
      try {
        if (!setup.renderer.isDestroyed) setup.renderer.destroy()
        await task
      } finally {
        await server.stop()
      }
    },
  }
}
