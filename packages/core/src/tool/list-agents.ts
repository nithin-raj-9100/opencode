export * as ListAgentsTool from "./list-agents"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionPeer } from "../session/peer"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "list_agents"

export const Input = Schema.Struct({})
export const Output = Schema.Struct({ agents: Schema.Array(SessionPeer.Info) })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const peers = yield* SessionPeer.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "List other running OpenCode sessions on this machine. Use the returned ref when sending a message, especially when titles or session IDs are duplicated.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output.agents, null, 2) }],
          execute: (_, context) =>
            permission
              .assert({
                action: name,
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.andThen(peers.list(context.sessionID)),
                Effect.map((agents) => ({ agents })),
                Effect.mapError(() => new ToolFailure({ message: "Unable to list running sessions" })),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/list-agents",
  layer,
  deps: [ToolRegistry.node, SessionPeer.node, PermissionV2.node],
})
