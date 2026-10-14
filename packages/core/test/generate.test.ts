import { expect } from "bun:test"
import { LanguageModel, LLMClient, ToolDefinition } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { AISDK } from "@opencode/core/aisdk"
import { App } from "@opencode/core/app"
import { Generate } from "@opencode/core/generate"
import { Integration } from "@opencode/core/integration"
import { ModelResolver } from "@opencode/core/model-resolver"
import { ID, Info, Model, Ref } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Tool } from "@opencode/core/tool"
import { Money } from "@opencode/schema/money"
import { Npm } from "@opencode/util/npm"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"

const selected = Info.make({
  ...Info.default(Provider.ID.make("test-provider"), ID.make("gemini")),
  package: Provider.aisdk("@ai-sdk/perplexity"),
})
const free = Info.make({
  ...Info.default(Provider.ID.opencode, ID.make("muse-spark-free")),
  package: Provider.aisdk("@ai-sdk/perplexity"),
})
const paid = Info.make({
  ...Info.default(Provider.ID.opencode, ID.make("muse-spark")),
  package: Provider.aisdk("@ai-sdk/perplexity"),
  cost: [
    {
      input: Money.USDPerMillionTokens.make(1),
      output: Money.USDPerMillionTokens.make(2),
      cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
    },
  ],
})
const catalog = [selected, free, paid]
const shell = ToolDefinition.make({ name: "shell", description: "Run a command", inputSchema: { type: "object" } })
const runtime = LanguageModel.make({ id: "gemini", provider: "test-provider", route: OpenAIChat.route })

const providers = Layer.mock(Provider.Service, {
  get: () => Effect.undefined,
})
const models = Layer.mock(Model.Service, {
  get: (providerID, modelID) =>
    Effect.succeed(catalog.find((model) => model.providerID === providerID && model.id === modelID) ?? selected),
})
const integrations = Layer.mock(Integration.Service, {
  revision: () => 0,
  connection: {
    active: () => Effect.undefined,
    resolve: () => Effect.die("unused"),
    key: () => Effect.die("unused"),
    external: () => Effect.die("unused"),
    activate: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
  },
  oauth: {
    connect: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    complete: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  },
  command: {
    connect: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  },
})
const npm = Layer.mock(Npm.Service, {
  add: () => Effect.die("unused"),
  which: () => Effect.die("unused"),
})
const aisdk = Layer.mock(AISDK.Service, {
  hook: {
    sdk: () => Effect.die("unused"),
    language: () => Effect.die("unused"),
  },
  model: () => Effect.succeed(runtime),
})
const tools = Layer.mock(Tool.Service, {
  snapshot: () => Effect.succeed({ definitions: [shell], execute: () => Effect.die("unused") }),
})
const client = TestLLM.testLayer({ fallback: TestLLM.text("OK", "generate") })

const resolver = ModelResolver.layer.pipe(Layer.provide(Layer.mergeAll(providers, models, integrations, npm, aisdk)))
const it = testEffect(Generate.layer.pipe(Layer.provideMerge(Layer.mergeAll(resolver, client, tools))))
const resolverIt = testEffect(resolver)

it.effect("loads dynamic AI SDK models", () =>
  Effect.gen(function* () {
    const generate = yield* Generate.Service
    const result = yield* generate.text({
      prompt: "Return exactly OK",
      model: Ref.make({ providerID: selected.providerID, id: selected.id }),
    })

    expect(result).toBe("OK")
  }),
)

it.effect("sends session routing headers when a session is given", () =>
  Effect.gen(function* () {
    const generate = yield* Generate.Service
    const llm = yield* TestLLM.Test
    yield* generate.text({
      prompt: "Return exactly OK",
      model: Ref.make({ providerID: selected.providerID, id: selected.id }),
      session: { id: "ses_child", projectID: "prj_test", parentID: "ses_parent" },
    })

    expect((yield* llm.requests()).at(-1)?.http?.headers).toEqual({
      "x-session-affinity": "ses_child",
      "X-Session-Id": "ses_child",
      "x-parent-session-id": "ses_parent",
      "User-Agent": App.useragent(App.make()),
      "x-opencode-project": "prj_test",
      "x-opencode-session": "ses_child",
      "x-opencode-client": "opencode",
    })
  }),
)

it.effect("advertises the tool set only for free OpenCode gateway models", () =>
  Effect.gen(function* () {
    const generate = yield* Generate.Service
    const llm = yield* TestLLM.Test
    const request = (model: Info) =>
      generate
        .text({ prompt: "Return exactly OK", model: Ref.make({ providerID: model.providerID, id: model.id }) })
        .pipe(Effect.andThen(llm.requests()), Effect.map((requests) => requests.at(-1)))

    const gateway = yield* request(free)
    expect(gateway?.tools.map((tool) => tool.name)).toEqual(["shell"])
    expect(gateway?.toolChoice).toBeUndefined()
    for (const model of [paid, selected]) expect((yield* request(model))?.tools).toEqual([])
  }),
)

resolverIt.effect("resolves dynamic models with their catalog metadata", () =>
  Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const result = yield* resolver.resolve(Ref.make({ providerID: selected.providerID, id: selected.id }))

    expect(result).toEqual({
      model: runtime,
      ref: Ref.make({ providerID: selected.providerID, id: selected.id }),
      capabilities: selected.capabilities,
      cost: selected.cost,
      limit: selected.limit,
    })
  }),
)

testEffect(Layer.empty).effect("attributes each stateless completion without creating a stored session", () =>
  Effect.gen(function* () {
    const sessions: string[] = []
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const session = request.headers["x-opencode-session"]
          if (!session)
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  error: { type: "MissingSessionID", message: "Session ID is required" },
                },
                { status: 400 },
              ),
            )
          sessions.push(session)
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              `data: ${JSON.stringify({
                id: "completion",
                object: "chat.completion.chunk",
                created: 1,
                model: "gemini",
                choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
              })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
          )
        }),
      ),
    )
    const native = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))
    yield* Effect.gen(function* () {
      const generate = yield* Generate.Service
      for (let index = 0; index < 2; index++) {
        expect(
          yield* generate.text({
            prompt: "Return exactly OK",
            model: Ref.make({ providerID: selected.providerID, id: selected.id }),
          }),
        ).toBe("OK")
      }
    }).pipe(Effect.provide(Generate.layer.pipe(Layer.provide(Layer.mergeAll(resolver, native, tools)))))
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toStartWith("ses_")
    expect(sessions[1]).not.toBe(sessions[0])
  }),
)
