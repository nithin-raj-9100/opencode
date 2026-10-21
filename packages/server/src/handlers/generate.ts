import { Generate } from "@opencode/core/generate"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { RaycastChatInput } from "@opencode/protocol/groups/generate"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { HttpServerResponse } from "effect/http"
import { Api } from "../api"
import { awaitPlugins, locationErrors } from "../location"
import { forward } from "../raycast-chat"

export const GenerateHandler = HttpApiBuilder.group(Api, "server.generate", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    return handlers.handleRaw(
      "generate.raycast",
      (request) => Effect.gen(function* () {
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
    ).handle(
      "generate.text",
      Effect.fn("server.generate.text")(
        function* (request) {
          yield* awaitPlugins
          const generate = yield* Generate.Service
          const text = yield* generate
            .text(request.payload)
            .pipe(
              Effect.mapError((error) =>
                error._tag === "Generate.ModelSelectionError"
                  ? new InvalidRequestError({ message: error.message })
                  : new ServiceUnavailableError({ message: error.message, service: error.service }),
              ),
            )
          return { data: { text } }
        },
        Effect.provide(services),
        locationErrors,
      ),
    )
  }),
)
