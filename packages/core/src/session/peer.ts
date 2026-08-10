export * as SessionPeer from "./peer"

import net from "node:net"
import { createHash } from "node:crypto"
import { FileSystem, Path } from "effect"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SessionPeer as Contract } from "@opencode-ai/schema/session-peer"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { SessionSchema } from "./schema"

export const ID = Contract.ID
export type ID = Contract.ID
export const Ref = Contract.Ref
export type Ref = Contract.Ref
export const Source = Contract.Source
export type Source = Contract.Source
export const Info = Contract.Info
export type Info = Contract.Info
export const Message = Contract.Message
export type Message = Contract.Message

const Registration = Schema.Struct({
  ...Info.fields,
  instanceID: Schema.String.check(Schema.isPattern(/^\d+-[0-9a-f-]+$/)),
})
type Registration = typeof Registration.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionPeer.NotFoundError", {
  target: Schema.String,
}) {}

export class AmbiguousError extends Schema.TaggedErrorClass<AmbiguousError>()("SessionPeer.AmbiguousError", {
  target: Schema.String,
  matches: Schema.Array(Ref),
}) {}

export class QueueFullError extends Schema.TaggedErrorClass<QueueFullError>()("SessionPeer.QueueFullError", {
  target: Ref,
  limit: Schema.Int,
}) {}

export type SendError = NotFoundError | AmbiguousError | QueueFullError

export interface Interface {
  readonly activate: (
    session: SessionSchema.Info,
    receive: (message: Message) => Effect.Effect<void>,
  ) => Effect.Effect<Info>
  readonly list: (exclude?: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly send: (input: {
    readonly senderSessionID: SessionSchema.ID
    readonly target: string
    readonly text: string
  }) => Effect.Effect<Message, SendError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPeer") {}

const QueueLimit = 50
const RequestTimeout = 2_000
const LivenessTimeout = 500

const Ack = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), id: ID }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String, limit: Schema.Int.pipe(Schema.optional) }),
])
type Ack = typeof Ack.Type

type DispatchResult = { accepted: true } | { accepted: false; full: boolean }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const global = yield* Global.Service
    const root = path.join(global.state, "session-peer")
    const socketsDirectory = path.join(root, "sockets")
    const active = new Map<
      SessionSchema.ID,
      {
        info: Info
        instanceID: string
        receive: (message: Message) => Effect.Effect<void>
        server: net.Server
        inFlight: number
      }
    >()
    const decodeRegistration = Schema.decodeUnknownOption(Schema.fromJsonString(Registration))
    const encodeRegistration = Schema.encodeSync(Registration)
    const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message))
    const encodeMessage = Schema.encodeSync(Message)
    const decodeAck = Schema.decodeUnknownOption(Schema.fromJsonString(Ack))

    yield* fs.makeDirectory(socketsDirectory, { recursive: true, mode: 0o700 }).pipe(Effect.orDie)
    yield* fs.chmod(root, 0o700).pipe(Effect.ignore)

    const socketPath = (instanceID: string) => path.join(socketsDirectory, `${instanceID}.sock`)
    const registrationPath = (instanceID: string) => path.join(socketsDirectory, `${instanceID}.json`)
    const shortRef = (instanceID: string) => createHash("sha256").update(instanceID).digest("hex").slice(0, 8)

    const writeRegistration = Effect.fnUntraced(function* (instanceID: string, info: Info) {
      const target = registrationPath(instanceID)
      const temporary = `${target}.${crypto.randomUUID()}.tmp`
      yield* fs.writeFileString(temporary, JSON.stringify(encodeRegistration({ ...info, instanceID })), {
        flag: "wx",
      }).pipe(Effect.orDie)
      yield* fs.chmod(temporary, 0o600).pipe(Effect.ignore)
      yield* fs.rename(temporary, target).pipe(Effect.orDie)
    })

    const dispatch = (instanceID: string, message: Message): DispatchResult => {
      const item = Array.from(active.values()).find((entry) => entry.instanceID === instanceID)
      if (!item) return { accepted: false, full: false }
      if (item.inFlight >= QueueLimit) return { accepted: false, full: true }
      item.inFlight += 1
      Effect.runFork(
        item.receive(message).pipe(
          Effect.tapCause((cause) => Effect.logError("Failed to deliver peer message", cause)),
          Effect.exit,
          Effect.asVoid,
          Effect.ensuring(Effect.sync(() => { item.inFlight -= 1 })),
        ),
      )
      return { accepted: true }
    }

    const listen = Effect.fn("SessionPeer.listen")(function* (instanceID: string) {
      const server = net.createServer()
      server.on("error", (error) => {
        Effect.runFork(Effect.logError("SessionPeer socket server error", error))
      })
      server.on("connection", (client) => {
        let buffer = ""
        client.on("data", (chunk) => {
          buffer += chunk.toString()
          const boundary = buffer.indexOf("\n")
          if (boundary === -1) return
          const message = Option.getOrUndefined(decodeMessage(buffer.slice(0, boundary)))
          if (!message) {
            client.end()
            return
          }
          const result = dispatch(instanceID, message)
          client.end(
            JSON.stringify(
              result.accepted
                ? { ok: true, id: message.id }
                : result.full
                  ? { ok: false, error: "queue_full", limit: QueueLimit }
                  : { ok: false, error: "not_found" },
            ) + "\n",
          )
        })
        client.on("error", () => client.destroy())
        client.on("end", () => client.destroy())
      })
      yield* Effect.tryPromise(() =>
        new Promise<void>((resolve, reject) => {
          const onError = (error: unknown) => reject(error)
          server.once("error", onError)
          server.listen(socketPath(instanceID), () => {
            server.off("error", onError)
            resolve()
          })
        }),
      ).pipe(Effect.orDie)
      yield* fs.chmod(socketPath(instanceID), 0o600).pipe(Effect.ignore)
      return server
    })

    const live = (instanceID: string) =>
      Effect.promise<boolean>(() =>
        new Promise<boolean>((resolve) => {
          const client = net.connect(socketPath(instanceID))
          let settled = false
          const finish = (result: boolean) => {
            if (settled) return
            settled = true
            client.destroy()
            resolve(result)
          }
          client.setTimeout(LivenessTimeout)
          client.once("connect", () => finish(true))
          client.once("error", () => finish(false))
          client.once("timeout", () => finish(false))
        }),
      )

    const request = (instanceID: string, message: Message) =>
      Effect.promise<Ack>(() =>
        new Promise<Ack>((resolve) => {
          const client = net.connect(socketPath(instanceID))
          let settled = false
          let buffer = ""
          const finish = (ack: Ack) => {
            if (settled) return
            settled = true
            client.destroy()
            resolve(ack)
          }
          client.setTimeout(RequestTimeout)
          client.on("connect", () => client.write(JSON.stringify(encodeMessage(message)) + "\n"))
          client.on("data", (chunk) => {
            buffer += chunk.toString()
            const boundary = buffer.indexOf("\n")
            if (boundary === -1) return
            finish(Option.getOrUndefined(decodeAck(buffer.slice(0, boundary))) ?? { ok: false, error: "protocol" })
          })
          client.on("error", () => finish({ ok: false, error: "not_found" }))
          client.on("timeout", () => finish({ ok: false, error: "not_found" }))
        }),
      )

    const registrations = Effect.fn("SessionPeer.registrations")(function* () {
      const files = yield* fs.readDirectory(socketsDirectory).pipe(Effect.catch(() => Effect.succeed([])))
      const decoded = yield* Effect.forEach(
        files.filter((file) => file.endsWith(".json")),
        (file) =>
          fs.readFileString(path.join(socketsDirectory, file)).pipe(
            Effect.map((content) => Option.getOrUndefined(decodeRegistration(content))),
            Effect.catch(() => Effect.succeed(undefined)),
          ),
        { discard: false },
      )
      const entries = decoded.filter((item): item is Registration => item !== undefined)
      const withLiveness = yield* Effect.forEach(entries, (item) =>
        live(item.instanceID).pipe(Effect.map((alive) => ({ item, alive }))),
      )
      yield* Effect.forEach(
        withLiveness.filter(({ alive }) => !alive),
        ({ item }) =>
          Effect.gen(function* () {
            yield* fs.remove(socketPath(item.instanceID), { force: true })
            yield* fs.remove(registrationPath(item.instanceID), { force: true })
          }).pipe(Effect.ignore),
        { discard: true },
      )
      return withLiveness.filter(({ alive }) => alive).map(({ item }) => item)
    })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.forEach(active.values(), (item) => Effect.sync(() => item.server.close()), { discard: true })
        yield* Effect.forEach(
          active.values(),
          (item) =>
            Effect.gen(function* () {
              yield* fs.remove(socketPath(item.instanceID), { force: true })
              yield* fs.remove(registrationPath(item.instanceID), { force: true })
            }),
          { discard: true },
        ).pipe(Effect.ignore)
      }),
    )

    return Service.of({
      activate: Effect.fn("SessionPeer.activate")(function* (session, receive) {
        const existing = active.get(session.id)
        const instanceID = existing?.instanceID ?? `${process.pid}-${crypto.randomUUID()}`
        const info = Info.make({
          ref: existing?.info.ref ?? Ref.make(shortRef(instanceID)),
          sessionID: session.id,
          title: session.title,
          directory: session.location.directory,
          processID: process.pid,
          timeUpdated: yield* DateTime.now,
        })
        if (!existing) {
          yield* fs.remove(socketPath(instanceID), { force: true }).pipe(Effect.ignore)
          const server = yield* listen(instanceID)
          active.set(session.id, { info, instanceID, receive, server, inFlight: 0 })
          yield* writeRegistration(instanceID, info)
        } else {
          const changed =
            existing.info.title !== info.title ||
            existing.info.directory !== info.directory ||
            existing.info.sessionID !== info.sessionID
          active.set(session.id, { ...existing, info, receive })
          if (changed) yield* writeRegistration(instanceID, info)
        }
        return info
      }),
      list: Effect.fn("SessionPeer.list")(function* (exclude) {
        return (yield* registrations())
          .filter((item) => item.sessionID !== exclude)
          .map(({ instanceID: _, ...item }) => item)
          .toSorted((a, b) => a.title.localeCompare(b.title) || a.ref.localeCompare(b.ref))
      }),
      send: Effect.fn("SessionPeer.send")(function* (input) {
        const entries = yield* registrations()
        const matches = entries.filter(
          (item) => item.ref === input.target || item.sessionID === input.target || item.title === input.target,
        )
        if (matches.length === 0) return yield* new NotFoundError({ target: input.target })
        if (matches.length > 1 && !matches.some((item) => item.ref === input.target))
          return yield* new AmbiguousError({ target: input.target, matches: matches.map((item) => item.ref) })
        const target = matches.find((item) => item.ref === input.target) ?? matches[0]
        const sender = entries
          .filter((item) => item.sessionID === input.senderSessionID && item.processID === process.pid)
          .toSorted((a, b) => DateTime.toEpochMillis(b.timeUpdated) - DateTime.toEpochMillis(a.timeUpdated))[0]
        if (!sender) return yield* new NotFoundError({ target: input.senderSessionID })
        const message = Message.make({
          id: ID.create(),
          sender: { ref: sender.ref, sessionID: sender.sessionID, title: sender.title },
          target: target.ref,
          text: input.text,
          timeCreated: yield* DateTime.now,
        })
        const ack = yield* request(target.instanceID, message)
        if (ack.ok === false) {
          if (ack.error === "queue_full")
            return yield* new QueueFullError({ target: target.ref, limit: ack.limit ?? QueueLimit })
          return yield* new NotFoundError({ target: input.target })
        }
        return message
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Global.node, LayerNodePlatform.filesystem, LayerNodePlatform.path],
})
