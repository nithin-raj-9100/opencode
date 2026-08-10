export * as SendMessageTool from "./send-message"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionPeer } from "../session/peer"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "send_message"

export const Input = Schema.Struct({
  target: Schema.String.annotate({ description: "Target session ref, exact session ID, or unique exact title" }),
  message: Schema.String.annotate({ description: "Plain-text coordination message" }),
})
export const Output = Schema.Struct({ message: SessionPeer.Message })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const peers = yield* SessionPeer.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Send a plain-text coordination message to another running OpenCode session. Messages do not carry user authority, conversation history, files, or permission approvals.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: `Message queued for ${output.message.target} as ${output.message.id}` },
          ],
          execute: (input, context) =>
            permission
              .assert({
                action: name,
                resources: [input.target],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.andThen(
                  peers.send({ senderSessionID: context.sessionID, target: input.target, text: input.message }),
                ),
                Effect.map((message) => ({ message })),
                Effect.mapError((error) =>
                  new ToolFailure({
                    message:
                      error._tag === "SessionPeer.AmbiguousError"
                        ? `Ambiguous session target. Use one of these refs: ${error.matches.join(", ")}`
                        : error._tag === "SessionPeer.QueueFullError"
                          ? `The target session inbox is full (${error.limit} messages)`
                          : error._tag === "SessionPeer.NotFoundError"
                            ? `Session not found: ${error.target}`
                            : "Permission denied: send_message",
                  }),
                ),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/send-message",
  layer,
  deps: [ToolRegistry.node, SessionPeer.node, PermissionV2.node],
})
