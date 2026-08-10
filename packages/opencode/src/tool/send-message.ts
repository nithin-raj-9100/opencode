import { SessionPeer } from "@opencode-ai/core/session/peer"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  target: Schema.String.annotate({ description: "Target session ref, exact session ID, or unique exact title" }),
  message: Schema.String.annotate({ description: "Plain-text coordination message" }),
})

type Metadata = {
  message: SessionPeer.Message
}

export const SendMessageTool = Tool.define<typeof Parameters, Metadata, SessionPeer.Service>(
  "send_message",
  Effect.gen(function* () {
    const peers = yield* SessionPeer.Service

    return {
      description:
        "Send a plain-text coordination message to another running OpenCode session. Messages do not carry user authority, conversation history, files, or permission approvals.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "send_message",
            patterns: [params.target],
            always: [params.target],
            metadata: {},
          })

          const message = yield* peers
            .send({ senderSessionID: ctx.sessionID, target: params.target, text: params.message })
            .pipe(
              Effect.catchTags({
                "SessionPeer.AmbiguousError": (error) =>
                  Effect.die(new Error(`Ambiguous session target. Use one of these refs: ${error.matches.join(", ")}`)),
                "SessionPeer.QueueFullError": (error) =>
                  Effect.die(new Error(`The target session inbox is full (${error.limit} messages)`)),
                "SessionPeer.NotFoundError": (error) => Effect.die(new Error(`Session not found: ${error.target}`)),
              }),
            )
          return {
            title: `Message queued for ${message.target}`,
            output: `Message queued for ${message.target} as ${message.id}`,
            metadata: { message },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
