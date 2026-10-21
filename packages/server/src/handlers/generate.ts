import { Generate } from "@opencode/core/generate"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import {
  InvalidRequestError,
  ModelNotFoundError,
  ProviderRequestError,
  ServiceUnavailableError,
  UnsupportedModelError,
} from "@opencode/protocol/errors"
import { RaycastChatInput } from "@opencode/protocol/groups/generate"
import type { DecisionRequest, ImageRequest } from "@opencode/schema/generate"
import { Model } from "@opencode/schema/model"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, locationErrors } from "../location"
import { forward } from "../raycast-chat"

export const GenerateHandler = HttpApiBuilder.group(Api, "server.generate", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    const text = Effect.fn("server.generate.text")(
      function* (request: { readonly payload: { readonly prompt: string; readonly model?: Model.Ref } }) {
        yield* awaitPlugins
        const generate = yield* Generate.Service
        return { data: { text: yield* generate.text(request.payload).pipe(Effect.mapError(generateError)) } }
      },
      Effect.provide(services),
      locationErrors,
    )
    const image = Effect.fn("server.generate.image")(
      function* (request: { readonly payload: ImageRequest }) {
        yield* awaitPlugins
        const generate = yield* Generate.Service
        return { data: yield* generate.image(request.payload).pipe(Effect.mapError(generateError)) }
      },
      Effect.provide(services),
      locationErrors,
    )
    const decisions = Effect.fn("server.generate.decisions")(
      function* (request: { readonly payload: DecisionRequest }) {
        const names = new Set(request.payload.questions.map((question) => question.name))
        if (names.size !== request.payload.questions.length)
          return yield* new InvalidRequestError({
            message: "Decision question names must be unique",
            field: "questions",
          })
        yield* awaitPlugins
        const generate = yield* Generate.Service
        return { data: yield* generate.decisions(request.payload).pipe(Effect.mapError(generateError)) }
      },
      Effect.provide(services),
      locationErrors,
    )
    return handlers
      .handleRaw(
        "generate.raycast",
        (request) =>
          Effect.gen(function* () {
            const payload = yield* request.request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(RaycastChatInput)),
              Effect.mapError(() => new InvalidRequestError({ message: "Invalid Raycast text chat request" })),
            )
            yield* awaitPlugins
            const integrations = yield* Integration.Service
            const connection = yield* integrations.connection.active(Integration.ID.make("opencode-go"))
            const credential = connection
              ? yield* integrations.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
              : undefined
            if (credential?.type !== "key")
              return HttpServerResponse.jsonUnsafe(
                { error: { message: "Connect OpenCode Go in oc3 first", type: "credentials_unavailable" } },
                { status: 503 },
              )
            return yield* forward(payload, credential.key)
          }).pipe(Effect.provide(services), locationErrors),
      )
      .handle("generate.text", text)
      .handle("generate.textLegacy", text)
      .handle("generate.image", image)
      .handle("generate.decisions", decisions)
  }),
)

function generateError(error: Generate.Error) {
  switch (error._tag) {
    case "Generate.ModelNotFoundError":
      return new ModelNotFoundError({ providerID: error.providerID, modelID: error.modelID, message: error.message })
    case "Generate.UnsupportedModelError":
      return new UnsupportedModelError({
        providerID: error.providerID,
        modelID: error.modelID,
        capability: error.capability,
        message: error.message,
      })
    case "Generate.InvalidRequestError":
      return new InvalidRequestError({
        message: error.message,
        ...(error.field === undefined ? {} : { field: error.field }),
      })
    case "Generate.ProviderRequestError":
      return new ProviderRequestError({
        providerID: error.providerID,
        reason: error.reason,
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      })
    case "Generate.UnavailableError":
      return new ServiceUnavailableError({
        message: error.message,
        ...(error.service === undefined ? {} : { service: error.service }),
      })
  }
}
