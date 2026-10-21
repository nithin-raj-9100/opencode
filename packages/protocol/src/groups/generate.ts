import { Model } from "@opencode/schema/model"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { LocationNotFoundError, InvalidRequestError, ServiceUnavailableError } from "../errors.js"

export const RaycastChatPath = "/api/raycast/v1/chat/completions"
export const RaycastChatInput = Schema.Struct({
  model: Schema.Literal("oc3-deepseek-v4.1-flash-max"),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["system", "developer", "user", "assistant"]),
      content: Schema.Union([
        Schema.String,
        Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
      ]),
    }),
  ).check(Schema.isMinLength(1)),
  stream: Schema.optional(Schema.Boolean),
  max_tokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(384000))),
  tools: Schema.optional(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(0))),
}).annotate({ identifier: "RaycastChatInput" })

export const GenerateGroup = HttpApiGroup.make("server.generate")
  .add(
    HttpApiEndpoint.post("generate.raycast", RaycastChatPath, {
      payload: RaycastChatInput,
      success: Schema.Unknown,
      error: [InvalidRequestError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.generate.raycast",
        summary: "Stream Raycast text chats through OpenCode Go",
        description: "OpenAI-compatible text chat for DeepSeek V4.1 Flash at maximum effort. No tools are executed.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("generate.text", "/api/experimental/generate", {
      payload: Schema.Struct({
        prompt: Schema.String,
        model: Model.Ref.pipe(Schema.optional),
      }),
      success: Schema.Struct({
        data: Schema.Struct({ text: Schema.String }),
      }).annotate({ identifier: "GenerateTextResponse" }),
      error: [InvalidRequestError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.generate.text",
        summary: "Generate text",
        description:
          "Run one stateless model generation using the server's base configuration and return the assistant text. Uses the base configuration's default model when none is specified.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "generate",
      description: "Experimental one-shot generation routes.",
    }),
  )
