import { Generate } from "@opencode/schema/generate"
import { Model } from "@opencode/schema/model"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import {
  InvalidRequestError,
  LocationNotFoundError,
  ModelNotFoundError,
  ProviderNotFoundError,
  ProviderRequestError,
  ServiceUnavailableError,
  UnsupportedModelError,
} from "../errors.js"

const errors = [
  InvalidRequestError,
  ProviderNotFoundError,
  ModelNotFoundError,
  UnsupportedModelError,
  ProviderRequestError,
  ServiceUnavailableError,
  LocationNotFoundError,
]

const textContract = {
  payload: Schema.Struct({
    prompt: Schema.String,
    model: Model.Ref.pipe(Schema.optional),
  }),
  success: Schema.Struct({
    data: Schema.Struct({ text: Schema.String }),
  }).annotate({ identifier: "GenerateTextResponse" }),
  error: errors,
}

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
    HttpApiEndpoint.post("generate.text", "/api/experimental/generate/text", textContract).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.generate.text",
        summary: "Generate text",
        description:
          "Run one stateless model generation using the server's base configuration and return the assistant text. Uses the base configuration's default model when none is specified.",
      }),
    ),
  )
  // Kept so clients built before the move to /generate/text keep working; omitted from generated clients.
  .add(
    HttpApiEndpoint.post("generate.textLegacy", "/api/experimental/generate", textContract).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.generate.textLegacy",
        summary: "Generate text (deprecated path)",
        description: "Deprecated alias of POST /api/experimental/generate/text.",
        deprecated: true,
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("generate.image", "/api/experimental/generate/image", {
      payload: Generate.ImageRequest,
      success: Schema.Struct({ data: Generate.ImageResult }).annotate({ identifier: "GenerateImageResponse" }),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.generate.image",
        summary: "Generate images",
        description:
          "Generate or edit images with an image model using the server's base configuration and return them as base64. Stateless: nothing is stored.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("generate.decisions", "/api/experimental/generate/decisions", {
      payload: Generate.DecisionRequest,
      success: Schema.Struct({ data: Generate.DecisionResult }).annotate({ identifier: "GenerateDecisionsResponse" }),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.generate.decisions",
        summary: "Generate decisions",
        description:
          "Ask a decision model typed predicate, choice and score questions about the input and return one probability-bearing answer per question, in question order. Stateless: nothing is stored.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "generate",
      description: "Experimental one-shot generation routes.",
    }),
  )
