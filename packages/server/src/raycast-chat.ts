import { RaycastChatInput } from "@opencode/protocol/groups/generate"
import { createHash } from "node:crypto"
import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/http"

export function sessionID(input: typeof RaycastChatInput.Type) {
  // Raycast v1 supplies history but no conversation ID. Routing affinity is derived
  // from the first user message; Go still receives the complete, stateless history.
  const first = input.messages.find((message) => message.role === "user") ?? input.messages[0]
  const text = typeof first.content === "string" ? first.content : first.content.map((part) => part.text).join("\n")
  return `raycast-${createHash("sha256").update(text).digest("hex")}`
}

export const forward = Effect.fn("RaycastChat.forward")(function* (
  input: typeof RaycastChatInput.Type,
  key: string,
  endpoint = "https://opencode.ai/inference/go/openai/v1/chat/completions",
) {
  const controller = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort()),
  )
  const upstream = yield* Effect.tryPromise({
    try: () =>
      fetch(endpoint, {
        method: "POST",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "User-Agent": "oc3-raycast/1.0",
          "x-opencode-session": sessionID(input),
        },
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          messages: input.messages,
          stream: input.stream ?? false,
          ...(input.max_tokens === undefined ? {} : { max_tokens: input.max_tokens }),
          thinking: { type: "enabled" },
          reasoning_effort: "max",
        }),
      }),
    catch: () => new Error("OpenCode Go connection failed"),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!upstream?.ok || !upstream.body) {
    yield* Effect.promise(() => upstream?.body?.cancel() ?? Promise.resolve())
    return HttpServerResponse.jsonUnsafe(
      { error: { message: "OpenCode Go request failed; check credentials and quota", type: "upstream_error" } },
      { status: 502 },
    )
  }
  return HttpServerResponse.stream(
    Stream.fromReadableStream({
      evaluate: () => upstream.body!,
      onError: () => new Error("OpenCode Go stream interrupted"),
    }),
    {
      contentType: input.stream ? "text/event-stream" : "application/json",
      headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    },
  )
})
