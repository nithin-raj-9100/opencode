import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Generate } from "@opencode/core/generate"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { PermissionAuto } from "@opencode/core/permission/auto"
import { PermissionAutoState } from "@opencode/core/permission/state"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigPermissionAuto } from "@opencode/schema/config/permission-auto"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const SESSION = Session.ID.make("ses_auto_service")

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)

// The fake classifier delegates to a mutable handler so each test programs its
// own verdicts and can capture the prompt the reviewer would have sent.
let handler: (input: Generate.TextInput) => Effect.Effect<string, Generate.Error> = () =>
  Effect.succeed("<allow>routine</allow>")

const generateLayer = Layer.succeed(
  Generate.Service,
  Generate.Service.of({ text: (input) => handler(input) }),
)

const settingsDoc = (info: ConfigPermissionAuto.Info) =>
  new Document({ type: "document", info: new Info({ permission_auto: info }) })

const harness = (entries: Entry[] = []) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        SessionStore.node,
        PermissionAutoState.node,
        PermissionAuto.node,
      ]),
      [
        Location.node.replace(current),
        Config.node.replace(Config.testLayer(entries)),
        Generate.node.replace(generateLayer),
      ],
    ),
  )

const it = harness()
const itDisabled = harness([settingsDoc(new ConfigPermissionAuto.Info({ disableAutoMode: true }))])
const itFallback = harness([
  settingsDoc(
    new ConfigPermissionAuto.Info({
      model: { providerID: Provider.ID.make("primary"), model: Model.ID.make("classifier") },
    }),
  ),
])

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: SESSION,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
      agent: "test",
      model: { id: "session-model", providerID: "session-provider" },
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const request = (id: string, overrides: Partial<Permission.Request> = {}): Permission.Request => ({
  id: Permission.ID.create(id),
  sessionID: SESSION,
  action: "shell",
  resources: ["rm -rf /tmp/work"],
  metadata: { command: "rm -rf /tmp/work" },
  ...overrides,
})

describe("PermissionAuto service", () => {
  it.effect("resumes auto mode after a human approves a classifier ask", () =>
    Effect.gen(function* () {
      yield* setup
      handler = () => Effect.succeed("<block>destructive</block>")
      const auto = yield* PermissionAuto.Service
      yield* auto.set(SESSION, true)

      expect((yield* auto.review(request("per_b1"))).decision).toBe("deny")
      expect((yield* auto.review(request("per_b2"))).decision).toBe("deny")
      expect((yield* auto.review(request("per_b3"))).decision).toBe("deny")
      const broken = yield* auto.review(request("per_b4"))
      expect(broken.decision).toBe("ask")
      expect((yield* auto.status(SESSION)).broken).toBe(true)

      const bus = yield* Bus.Service
      yield* bus.publish(Permission.Event.Replied, {
        sessionID: SESSION,
        requestID: Permission.ID.create("per_b4"),
        reply: "once",
      })
      expect((yield* auto.status(SESSION)).broken).toBe(false)

      handler = () => Effect.succeed("<allow>routine</allow>")
      expect((yield* auto.review(request("per_b5"))).decision).toBe("allow")
    }),
  )

  itDisabled.effect("ignores enable requests when disableAutoMode is set", () =>
    Effect.gen(function* () {
      yield* setup
      const auto = yield* PermissionAuto.Service
      yield* auto.set(SESSION, true)
      expect(yield* auto.enabled(SESSION)).toBe(false)
      expect((yield* auto.status(SESSION)).disabled).toBe(true)
    }),
  )

  it.effect("classifies subagent delegation with the task prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const prompts: string[] = []
      handler = (input) => {
        prompts.push(input.prompt)
        return Effect.succeed("<allow>routine</allow>")
      }
      const auto = yield* PermissionAuto.Service
      yield* auto.set(SESSION, true)
      const review = yield* auto.review(
        request("per_delegation", {
          action: "subagent",
          resources: ["general"],
          metadata: { agent: "general", description: "audit", prompt: "Audit the deployment scripts" },
        }),
      )
      expect(review.decision).toBe("allow")
      expect(prompts.some((prompt) => prompt.includes("Audit the deployment scripts"))).toBe(true)
    }),
  )

  it.effect("critique reports when no custom rules exist", () =>
    Effect.gen(function* () {
      yield* setup
      const auto = yield* PermissionAuto.Service
      expect(yield* auto.critique()).toContain("No custom auto mode rules")
    }),
  )

  itFallback.live("falls back to the session model when the configured classifier model is unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const providers: string[] = []
      handler = (input) => {
        providers.push(String(input.model?.providerID ?? "none"))
        return input.model?.providerID === "primary"
          ? Effect.fail(new Generate.UnavailableError({ message: "down", retryAfterMs: 1 }))
          : Effect.succeed("<allow>routine</allow>")
      }
      const auto = yield* PermissionAuto.Service
      yield* auto.set(SESSION, true)
      const review = yield* auto.review(request("per_fallback"))
      expect(review.decision).toBe("allow")
      expect(providers).toContain("primary")
      expect(providers).toContain("session-provider")
    }),
  )

  it.live("fails closed when the classifier is unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      handler = () => Effect.fail(new Generate.UnavailableError({ message: "down", retryAfterMs: 1 }))
      const auto = yield* PermissionAuto.Service
      yield* auto.set(SESSION, true)
      const review = yield* auto.review(request("per_unavailable"))
      expect(review.decision).toBe("deny")
      expect(PermissionAuto.isUnevaluated(review)).toBe(true)
      if (review.decision === "deny") expect(review.reason).toContain("down")
    }),
  )
})
