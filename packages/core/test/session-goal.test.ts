import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { Money } from "@opencode/schema/money"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionGoal } from "@opencode/core/session/goal"
import { SessionGoalContinuation } from "@opencode/core/session/goal-continuation"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionStore } from "@opencode/core/session/store"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionGoal.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

const continueIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionGoal.node,
      SessionGoalContinuation.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("SessionGoal", () => {
  it.effect("creates, updates, and clears a session goal", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      const goal = yield* goals.set({ sessionID: created.id, objective: "Ship the TUI goal harness" })
      expect(goal.status).toBe("active")
      expect(goal.objective).toBe("Ship the TUI goal harness")
      expect(goal.tokensUsed).toBe(0)
      expect((yield* goals.get(created.id))?.goalID).toBe(goal.goalID)

      const paused = yield* goals.set({ sessionID: created.id, status: "paused" })
      expect(paused.goalID).toBe(goal.goalID)
      expect(paused.status).toBe("paused")

      expect(yield* goals.clear(created.id)).toBe(true)
      expect(yield* goals.get(created.id)).toBeUndefined()
      expect(yield* goals.clear(created.id)).toBe(false)
    }),
  )

  it.effect("rejects agent create while an unfinished goal exists", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.create({ sessionID: created.id, objective: "Keep going" })
      const error = yield* Effect.flip(goals.create({ sessionID: created.id, objective: "Something else" }))
      expect(error._tag).toBe("SessionGoal.UnfinishedError")
      yield* goals.set({ sessionID: created.id, status: "complete" })
      const next = yield* goals.create({ sessionID: created.id, objective: "Next goal" })
      expect(next.objective).toBe("Next goal")
      expect(next.status).toBe("active")
    }),
  )

  it.effect("keeps budget_limited sticky against pause and block", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.set({
        sessionID: created.id,
        objective: "Stay under budget",
        tokenBudget: 10,
      })
      const limited = yield* goals.account({ sessionID: created.id, tokens: 10 })
      expect(limited?.status).toBe("budget_limited")
      const paused = yield* goals.set({ sessionID: created.id, status: "paused" })
      expect(paused.status).toBe("budget_limited")
      const blocked = yield* goals.set({ sessionID: created.id, status: "blocked" })
      expect(blocked.status).toBe("budget_limited")
      const resumed = yield* goals.set({ sessionID: created.id, status: "active" })
      expect(resumed.status).toBe("budget_limited")
    }),
  )

  it.effect("pauses an active goal on user interrupt", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Do not stop unless asked" })
      expect((yield* goals.pauseActive(created.id))?.status).toBe("paused")
    }),
  )

  it.effect("patches an existing goal identity when the objective changes", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      const first = yield* goals.set({
        sessionID: created.id,
        objective: "Ship the first draft",
        tokenBudget: 100,
      })
      yield* goals.account({ sessionID: created.id, tokens: 7, seconds: 3 })
      const updated = yield* goals.set({ sessionID: created.id, objective: "Ship the revised draft" })
      expect(updated.goalID).toBe(first.goalID)
      expect(updated.objective).toBe("Ship the revised draft")
      expect(updated.tokensUsed).toBe(7)
      expect(updated.timeUsedSeconds).toBe(3)
      expect(updated.tokenBudget).toBe(100)
    }),
  )

  it.effect("rejects a status-only update when no goal exists", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      const error = yield* Effect.flip(goals.set({ sessionID: created.id, status: "paused" }))
      expect(error._tag).toBe("SessionGoal.MissingError")
    }),
  )

  it.effect("accounts tokens and time after a goal is completed", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Keep usage after complete", tokenBudget: 10 })
      yield* goals.set({ sessionID: created.id, status: "complete" })
      const updated = yield* goals.account({ sessionID: created.id, tokens: 50, seconds: 9 })
      expect(updated?.status).toBe("complete")
      expect(updated?.tokensUsed).toBe(50)
      expect(updated?.timeUsedSeconds).toBe(9)
    }),
  )

  it.effect("does not copy a goal onto a forked session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      yield* bus.publish(SessionEvent.Synthetic, { sessionID: created.id, text: "Keep this message" })
      yield* goals.set({ sessionID: created.id, objective: "Do not copy me" })
      const forked = yield* session.fork({ sessionID: created.id, boundary: { type: "through" } })
      expect(yield* goals.get(forked.id)).toBeUndefined()
      expect((yield* goals.get(created.id))?.objective).toBe("Do not copy me")
    }),
  )
})

describe("SessionGoalContinuation", () => {
  continueIt.effect("admits a synthetic continuation steer for an idle active goal", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Continue until verified" })
      yield* Effect.yieldNow
      const pending = yield* session.inbox(created.id)
      const item = pending.find((entry) => entry.type === "synthetic")
      expect(item?.type).toBe("synthetic")
      if (item?.type !== "synthetic") return
      expect(item.delivery).toBe("steer")
      expect(item.payload.metadata).toEqual({ source: "goal", kind: "continuation" })
      expect(item.payload.text).toContain("Continue until verified")
    }),
  )

  continueIt.effect("pauses the active goal when a user interrupt is published", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Pause on interrupt", status: "paused" })
      yield* goals.set({ sessionID: created.id, status: "active" })
      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID: created.id, reason: "user" })
      yield* Effect.yieldNow
      expect((yield* goals.get(created.id))?.status).toBe("paused")
    }),
  )

  continueIt.effect("admits a continuation steer when a paused goal is resumed", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Resume and continue", status: "paused" })
      yield* Effect.yieldNow
      expect((yield* session.inbox(created.id)).some((entry) => entry.type === "synthetic")).toBe(false)
      yield* goals.set({ sessionID: created.id, status: "active" })
      yield* Effect.yieldNow
      const pending = yield* session.inbox(created.id)
      const item = pending.find((entry) => entry.type === "synthetic")
      expect(item?.payload.metadata).toEqual({ source: "goal", kind: "continuation" })
    }),
  )

  continueIt.effect("marks an active goal usage_limited on provider quota failures", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Stop on quota", status: "paused" })
      yield* goals.set({ sessionID: created.id, status: "active" })
      yield* bus.publish(SessionEvent.Execution.Failed, {
        sessionID: created.id,
        error: { type: "provider.quota", message: "quota exceeded" },
      })
      yield* Effect.yieldNow
      expect((yield* goals.get(created.id))?.status).toBe("usage_limited")
    }),
  )

  continueIt.effect("blocks after three empty automatic continuations", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Stop after empty turns" })
      yield* Effect.yieldNow
      yield* emptyContinuation(created.id)
      yield* emptyContinuation(created.id)
      expect((yield* goals.get(created.id))?.status).toBe("active")
      yield* emptyContinuation(created.id)
      expect((yield* goals.get(created.id))?.status).toBe("blocked")
    }),
  )

  continueIt.effect("blocks after three consecutive shell failures without a successful tool", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Stop after shell failures", status: "paused" })
      yield* goals.set({ sessionID: created.id, status: "active" })
      yield* Effect.yieldNow
      yield* failedShell(created.id)
      yield* failedShell(created.id)
      expect((yield* goals.get(created.id))?.status).toBe("active")
      yield* failedShell(created.id)
      expect((yield* goals.get(created.id))?.status).toBe("blocked")
    }),
  )

  continueIt.effect("charges billed tokens including reasoning and excluding cache", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Count billed tokens", status: "paused" })
      yield* goals.set({ sessionID: created.id, status: "active" })
      yield* Effect.yieldNow
      yield* bus.publish(SessionEvent.Execution.Started, { sessionID: created.id })
      yield* Effect.yieldNow
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID: SessionMessage.ID.create(),
        finish: "stop",
        cost: Money.USD.make(0),
        tokens: billedUsage,
      })
      yield* Effect.yieldNow
      expect((yield* goals.get(created.id))?.tokensUsed).toBe(115)
    }),
  )

  continueIt.effect("charges the current execution after the agent completes the goal", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Keep in-flight usage", status: "paused" })
      yield* goals.set({ sessionID: created.id, status: "active" })
      yield* Effect.yieldNow
      yield* bus.publish(SessionEvent.Execution.Started, { sessionID: created.id })
      yield* Effect.yieldNow
      yield* TestClock.adjust("4 seconds")
      yield* goals.set({ sessionID: created.id, status: "complete" })
      yield* Effect.yieldNow
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID: SessionMessage.ID.create(),
        finish: "stop",
        cost: Money.USD.make(0),
        tokens: billedUsage,
      })
      yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: created.id })
      yield* Effect.yieldNow
      const goal = yield* goals.get(created.id)
      expect(goal?.status).toBe("complete")
      expect(goal?.tokensUsed).toBe(115)
      expect(goal?.timeUsedSeconds).toBe(4)
    }),
  )

  continueIt.effect("does not treat a later empty step as an empty execution when earlier steps had tools", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Keep going after tools" })
      yield* Effect.yieldNow
      yield* successfulToolThenEmpty(created.id)
      yield* successfulToolThenEmpty(created.id)
      yield* successfulToolThenEmpty(created.id)
      expect((yield* goals.get(created.id))?.status).toBe("active")
    }),
  )

  continueIt.effect("blocks after three shell failures even when the final step is text-only", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Count shell failures across the execution", status: "paused" })
      yield* goals.set({ sessionID: created.id, status: "active" })
      yield* Effect.yieldNow
      yield* failedShellThenText(created.id)
      yield* failedShellThenText(created.id)
      expect((yield* goals.get(created.id))?.status).toBe("active")
      yield* failedShellThenText(created.id)
      expect((yield* goals.get(created.id))?.status).toBe("blocked")
    }),
  )

  continueIt.effect("starts a fresh blocked audit when a blocked goal is resumed", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Reset empty streak on resume" })
      yield* Effect.yieldNow
      yield* emptyContinuation(created.id)
      yield* emptyContinuation(created.id)
      yield* emptyContinuation(created.id)
      expect((yield* goals.get(created.id))?.status).toBe("blocked")
      yield* goals.set({ sessionID: created.id, status: "active" })
      yield* Effect.yieldNow
      yield* emptyContinuation(created.id)
      expect((yield* goals.get(created.id))?.status).toBe("active")
    }),
  )

  continueIt.effect("charges a goal created during an existing execution", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      yield* bus.publish(SessionEvent.Execution.Started, { sessionID: created.id })
      yield* Effect.yieldNow
      yield* goals.create({ sessionID: created.id, objective: "Created mid-execution" })
      yield* Effect.yieldNow
      yield* TestClock.adjust("3 seconds")
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID: SessionMessage.ID.create(),
        finish: "stop",
        cost: Money.USD.make(0),
        tokens: billedUsage,
      })
      yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: created.id })
      yield* Effect.yieldNow
      const goal = yield* goals.get(created.id)
      expect(goal?.tokensUsed).toBe(115)
      expect(goal?.timeUsedSeconds).toBe(3)
    }),
  )

  continueIt.effect("charges a goal that is created and completed in the same execution", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      yield* bus.publish(SessionEvent.Execution.Started, { sessionID: created.id })
      yield* Effect.yieldNow
      yield* goals.create({ sessionID: created.id, objective: "Create and finish" })
      yield* goals.set({ sessionID: created.id, status: "complete" })
      yield* Effect.yieldNow
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID: SessionMessage.ID.create(),
        finish: "stop",
        cost: Money.USD.make(0),
        tokens: billedUsage,
      })
      yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: created.id })
      yield* Effect.yieldNow
      const goal = yield* goals.get(created.id)
      expect(goal?.status).toBe("complete")
      expect(goal?.tokensUsed).toBe(115)
    }),
  )

  continueIt.effect("charges a paused goal resumed during an existing execution", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Resume mid-execution", status: "paused" })
      yield* Effect.yieldNow
      yield* bus.publish(SessionEvent.Execution.Started, { sessionID: created.id })
      yield* Effect.yieldNow
      yield* goals.set({ sessionID: created.id, status: "active" })
      yield* Effect.yieldNow
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID: SessionMessage.ID.create(),
        finish: "stop",
        cost: Money.USD.make(0),
        tokens: billedUsage,
      })
      yield* Effect.yieldNow
      expect((yield* goals.get(created.id))?.tokensUsed).toBe(115)
    }),
  )

  continueIt.effect("does not treat an execution as empty when a later steer hides earlier tools", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const created = yield* session.create({ location })
      yield* goals.set({ sessionID: created.id, objective: "Keep activity across a steer" })
      yield* Effect.yieldNow
      yield* successfulToolThenSteerThenEmpty(created.id)
      yield* successfulToolThenSteerThenEmpty(created.id)
      yield* successfulToolThenSteerThenEmpty(created.id)
      expect((yield* goals.get(created.id))?.status).toBe("active")
    }),
  )
})

const model = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("opencode") })
const agent = Agent.ID.make("build")
const billedUsage = { input: 10, output: 5, reasoning: 100, cache: { read: 1000, write: 50 } }

const emptyContinuation = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    yield* SessionInbox.promote(db, bus, sessionID, "steer")
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID: SessionMessage.ID.create(),
      agent,
      model,
    })
    yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
    yield* Effect.yieldNow
    yield* Effect.yieldNow
  })

const failedShell = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const assistantMessageID = SessionMessage.ID.create()
    const callID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent, model })
    yield* bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID,
      id: callID,
      name: "shell",
    })
    yield* bus.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID,
      id: callID,
      text: "{}",
    })
    yield* bus.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID,
      id: callID,
      input: { command: "false" },
      executed: true,
    })
    yield* bus.publish(SessionEvent.Tool.Failed, {
      sessionID,
      assistantMessageID,
      id: callID,
      error: { type: "unknown", message: "exit 1" },
      executed: true,
    })
    yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
    yield* Effect.yieldNow
    yield* Effect.yieldNow
  })

const successfulToolThenEmpty = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    yield* SessionInbox.promote(db, bus, sessionID, "steer")
    const first = SessionMessage.ID.create()
    const second = SessionMessage.ID.create()
    const callID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: first, agent, model })
    yield* bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      name: "read",
    })
    yield* bus.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      text: "{}",
    })
    yield* bus.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      input: { path: "README.md" },
      executed: true,
    })
    yield* bus.publish(SessionEvent.Tool.Success, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      content: [{ type: "text", text: "ok" }],
      executed: true,
    })
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: second, agent, model })
    yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
    yield* Effect.yieldNow
    yield* Effect.yieldNow
  })

const failedShellThenText = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const first = SessionMessage.ID.create()
    const second = SessionMessage.ID.create()
    const callID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: first, agent, model })
    yield* bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      name: "shell",
    })
    yield* bus.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      text: "{}",
    })
    yield* bus.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      input: { command: "false" },
      executed: true,
    })
    yield* bus.publish(SessionEvent.Tool.Failed, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      error: { type: "unknown", message: "exit 1" },
      executed: true,
    })
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: second, agent, model })
    yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: second, ordinal: 0 })
    yield* bus.publish(SessionEvent.Text.Ended, {
      sessionID,
      assistantMessageID: second,
      ordinal: 0,
      text: "still working",
    })
    yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
    yield* Effect.yieldNow
    yield* Effect.yieldNow
  })

const successfulToolThenSteerThenEmpty = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    yield* SessionInbox.promote(db, bus, sessionID, "steer")
    const first = SessionMessage.ID.create()
    const second = SessionMessage.ID.create()
    const callID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: first, agent, model })
    yield* bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      name: "read",
    })
    yield* bus.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      text: "{}",
    })
    yield* bus.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      input: { path: "README.md" },
      executed: true,
    })
    yield* bus.publish(SessionEvent.Tool.Success, {
      sessionID,
      assistantMessageID: first,
      id: callID,
      content: [{ type: "text", text: "ok" }],
      executed: true,
    })
    yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: "interjected work", description: "steer" })
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: second, agent, model })
    yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
    yield* Effect.yieldNow
    yield* Effect.yieldNow
  })
