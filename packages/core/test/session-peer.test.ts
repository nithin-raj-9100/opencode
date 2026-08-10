import { describe, expect } from "bun:test"
import { DateTime, Deferred, Duration, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionPeer } from "@opencode-ai/core/session/peer"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)

const session = (id: string, title: string, directory: string, now: DateTime.Utc) =>
  SessionV2.Info.make({
    id: SessionV2.ID.make(id),
    projectID: ProjectV2.ID.global,
    title,
    location: { directory: AbsolutePath.make(directory) },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now },
  })

describe("SessionPeer", () => {
  it.live("discovers active sessions and delivers a plain-text message", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tmpdir())
      const layer = AppNodeBuilder.build(SessionPeer.node, [[Global.node, Global.layerWith({ state: root.path })]])
      yield* Effect.gen(function* () {
        const peers = yield* SessionPeer.Service
        const received = yield* Deferred.make<SessionPeer.Message>()
        const now = yield* DateTime.now
        const sender = session("ses_peer_sender", "backend", root.path, now)
        const receiver = session("ses_peer_receiver", "frontend", root.path, now)
        yield* peers.activate(sender, () => Effect.void)
        const target = yield* peers.activate(receiver, (message) => Deferred.succeed(received, message))

        expect(yield* peers.list(sender.id)).toMatchObject([
          { ref: target.ref, sessionID: receiver.id, title: receiver.title, directory: root.path },
        ])
        const sent = yield* peers.send({ senderSessionID: sender.id, target: target.ref, text: "Schema is ready" })
        expect(yield* Deferred.await(received).pipe(Effect.timeout(Duration.seconds(2)))).toEqual(sent)
      }).pipe(Effect.provide(layer))
      yield* Effect.promise(() => root[Symbol.asyncDispose]())
    }),
  )

  it.live("requires a ref when an exact title is ambiguous", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tmpdir())
      const layer = AppNodeBuilder.build(SessionPeer.node, [[Global.node, Global.layerWith({ state: root.path })]])
      yield* Effect.gen(function* () {
        const peers = yield* SessionPeer.Service
        const now = yield* DateTime.now
        const sender = session("ses_peer_source", "source", root.path, now)
        yield* peers.activate(sender, () => Effect.void)
        yield* peers.activate(session("ses_peer_one", "worker", root.path, now), () => Effect.void)
        yield* peers.activate(session("ses_peer_two", "worker", root.path, now), () => Effect.void)

        expect(yield* Effect.flip(peers.send({ senderSessionID: sender.id, target: "worker", text: "status?" }))).toBeInstanceOf(
          SessionPeer.AmbiguousError,
        )
      }).pipe(Effect.provide(layer))
      yield* Effect.promise(() => root[Symbol.asyncDispose]())
    }),
  )
})
