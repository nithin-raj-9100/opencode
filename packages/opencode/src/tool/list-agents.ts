import { SessionPeer } from "@opencode-ai/core/session/peer"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({})

type Metadata = {
  agents: ReadonlyArray<SessionPeer.Info>
}

export const ListAgentsTool = Tool.define<typeof Parameters, Metadata, SessionPeer.Service>(
  "list_agents",
  Effect.gen(function* () {
    const peers = yield* SessionPeer.Service

    return {
      description:
        "List other running OpenCode sessions on this machine. Use the returned ref when sending a message, especially when titles or session IDs are duplicated.",
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "list_agents",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const agents = yield* peers.list(ctx.sessionID)
          return {
            title: "Running OpenCode sessions",
            output: JSON.stringify(agents, null, 2),
            metadata: { agents },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
