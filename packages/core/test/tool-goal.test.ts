import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Session } from "@opencode/core/session"
import { SessionGoal } from "@opencode/core/session/goal"
import { Tool } from "@opencode/core/tool"
import { GoalTools } from "@opencode/core/tool/plugin/goal"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"
import { host } from "./plugin/host"

const sessionID = Session.ID.make("ses_goal_tool_test")
const goalID = SessionGoal.ID.make("gol_test")

const info = (status: SessionGoal.Status): SessionGoal.Info =>
  SessionGoal.Info.make({
    sessionID,
    goalID,
    objective: "Ship the TUI goal harness",
    status,
    tokenBudget: 5000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: 1, updated: 1 },
  })

let current: SessionGoal.Info | undefined

const goals = SessionGoal.Service.of({
  get: () => Effect.succeed(current),
  listActive: () => Effect.succeed(current?.status === "active" ? [current] : []),
  set: (input) =>
    Effect.gen(function* () {
      if (!current)
        return yield* new SessionGoal.MissingError({
          sessionID: input.sessionID,
          message: "cannot update goal because this session has no goal",
        })
      current = SessionGoal.Info.make({
        ...current,
        status: input.status ?? current.status,
        time: { ...current.time, updated: 2 },
      })
      return current
    }),
  create: (input) =>
    Effect.gen(function* () {
      if (current && SessionGoal.unfinished(current.status))
        return yield* new SessionGoal.UnfinishedError({
          sessionID: input.sessionID,
          message:
            "cannot create a new goal because this session has an unfinished goal; complete the existing goal first",
        })
      current = info("active")
      return current
    }),
  clear: () =>
    Effect.sync(() => {
      const existed = current !== undefined
      current = undefined
      return existed
    }),
  pauseActive: () => Effect.succeed(current),
  usageLimitActive: () => Effect.succeed(current),
  blockActive: () => Effect.succeed(current),
  account: () => Effect.succeed(current),
})

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Tool.node])))

describe("GoalTools", () => {
  it.effect("creates, reads, and completes a session goal", () =>
    Effect.gen(function* () {
      current = undefined
      const registry = yield* Tool.Service
      yield* GoalTools.Plugin.effect(
        host({
          session: {
            hook: () => Effect.succeed({ dispose: Effect.void }),
            get: () => Effect.succeed({ title: "Existing session" } as never),
            rename: () => Effect.die("unused session.rename"),
          },
          tool: {
            transform: registry.transform,
            reload: registry.reload,
            hook: () => Effect.die("unused tool.hook"),
          },
        }),
      ).pipe(Effect.provideService(SessionGoal.Service, goals))

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
        "create_goal",
        "get_goal",
        "update_goal",
        "execute",
      ])

      const createdGoal = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-create-goal",
          name: "create_goal",
          input: { objective: "Ship the TUI goal harness", token_budget: 5000 },
        },
      })
      expect(createdGoal).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "Goal active." }],
        output: {
          remainingTokens: 5000,
          completionBudgetReport: null,
          goal: {
            sessionID,
            objective: "Ship the TUI goal harness",
            status: "active",
            tokenBudget: 5000,
            tokensUsed: 0,
          },
        },
      })

      const unfinished = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-create-goal-unfinished",
          name: "create_goal",
          input: { objective: "Something else" },
        },
      })
      expect(unfinished.status).toBe("error")
      expect(unfinished.error).toMatchObject({
        message: expect.stringContaining("unfinished goal"),
      })

      const completed = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-update-goal",
          name: "update_goal",
          input: { status: "complete" },
        },
      })
      expect(completed).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "Goal complete." }],
        output: {
          remainingTokens: 5000,
          goal: { status: "complete" },
        },
      })
      expect(String(completed.output?.completionBudgetReport ?? "")).toContain("Goal achieved")

      const currentGoal = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-get-goal", name: "get_goal", input: {} },
      })
      expect(currentGoal).toMatchObject({
        status: "completed",
        output: { goal: { status: "complete" }, remainingTokens: 5000 },
        content: [{ type: "text", text: "Goal complete." }],
      })
    }),
  )
})
