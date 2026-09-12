export * as SessionGoalContinuation from "./goal-continuation.js"

import { Clock, Context, Effect, Layer, Stream } from "effect"
import { TokenUsage } from "@opencode/schema/token-usage"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Session } from "../session.js"
import { SessionEvent } from "./event.js"
import { SessionGoal } from "./goal.js"
import { SessionGoalTemplates } from "./goal-templates.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

export const MetadataSource = "goal"

export type Kind = "continuation" | "objective_updated" | "budget_limit"

export interface Interface {
  readonly continueIfIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoalContinuation") {}

type Accounting = {
  goalID: SessionGoal.ID
  emptyStreak: number
  execFailureStreak: number
  lastAccountedAt: number
  lastContinuation: boolean
  charging: boolean
}

type ExecutionAudit = {
  running: boolean
  hasActivity: boolean
  emptyFinal: boolean
  successfulTool: boolean
  failedShell: boolean
  tools: Map<string, string>
}

const isGoalMetadata = (metadata: Record<string, unknown> | undefined, kind?: Kind) => {
  if (metadata?.source !== MetadataSource) return false
  if (kind === undefined) return true
  return metadata.kind === kind
}

const chargeable = (status: SessionGoal.Status) => status === "active" || status === "budget_limited"

const newExecution = (): ExecutionAudit => ({
  running: true,
  hasActivity: false,
  emptyFinal: false,
  successfulTool: false,
  failedShell: false,
  tools: new Map(),
})

const usageLimited = (type: string) => type === "provider.rate-limit" || type === "provider.quota"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const store = yield* SessionStore.Service
    const seen = new Map<SessionSchema.ID, SessionGoal.Info>()
    const accounting = new Map<SessionSchema.ID, Accounting>()
    const executions = new Map<SessionSchema.ID, ExecutionAudit>()

    const forget = (sessionID: SessionSchema.ID) => {
      seen.delete(sessionID)
      accounting.delete(sessionID)
    }

    const track = (goal: SessionGoal.Info) => {
      const current = accounting.get(goal.sessionID)
      if (current?.goalID === goal.goalID) return current
      const next: Accounting = {
        goalID: goal.goalID,
        emptyStreak: 0,
        execFailureStreak: 0,
        lastAccountedAt: Date.now(),
        lastContinuation: false,
        charging: false,
      }
      accounting.set(goal.sessionID, next)
      return next
    }

    const execution = (sessionID: SessionSchema.ID) => {
      const current = executions.get(sessionID)
      if (current) return current
      const next = newExecution()
      executions.set(sessionID, next)
      return next
    }

    const busy = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      if (executions.get(sessionID)?.running) return true
      const active = yield* sessions.active
      if (active.has(sessionID)) return true
      const suspended = yield* store.listSuspended()
      return suspended.some((id) => id === sessionID)
    })

    const admit = Effect.fnUntraced(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly text: string
      readonly kind: Kind
    }) {
      yield* sessions
        .synthetic({
          sessionID: input.sessionID,
          text: input.text,
          description: "session goal",
          metadata: { source: MetadataSource, kind: input.kind },
          delivery: "steer",
        })
        .pipe(Effect.catch(() => Effect.void))
      if (input.kind !== "continuation") return
      const goal = yield* goals.get(input.sessionID)
      if (goal) track(goal).lastContinuation = true
    })

    const continueIfIdle = Effect.fn("SessionGoalContinuation.continueIfIdle")(function* (
      sessionID: SessionSchema.ID,
    ) {
      const goal = yield* goals.get(sessionID)
      if (!goal || goal.status !== "active") return
      if (yield* busy(sessionID)) return
      yield* admit({
        sessionID,
        text: SessionGoalTemplates.continuation(goal),
        kind: "continuation",
      })
    })

    const chargeTime = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, goal: SessionGoal.Info) {
      const current = track(goal)
      const now = yield* Clock.currentTimeMillis
      const seconds = Math.max(0, Math.floor((now - current.lastAccountedAt) / 1000))
      current.lastAccountedAt = now
      if (seconds === 0) return goal
      return (yield* goals.account({ sessionID, seconds })) ?? goal
    })

    const beginCharging = Effect.fnUntraced(function* (goal: SessionGoal.Info) {
      if (!chargeable(goal.status)) return
      const current = track(goal)
      if (current.charging) return
      current.charging = true
      current.lastAccountedAt = yield* Clock.currentTimeMillis
    })

    const finishCharging = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const goal = yield* goals.get(sessionID)
      const current = goal ? accounting.get(goal.sessionID) : undefined
      if (goal && current?.charging && current.goalID === goal.goalID) yield* chargeTime(sessionID, goal)
      if (current) current.charging = false
      return goal
    })

    yield* bus
      .subscribe([
        SessionEvent.GoalUpdated,
        SessionEvent.GoalCleared,
        SessionEvent.Execution.Started,
        SessionEvent.Execution.Succeeded,
        SessionEvent.Execution.Failed,
        SessionEvent.Execution.Interrupted,
        SessionEvent.Step.Started,
        SessionEvent.Step.Ended,
        SessionEvent.Text.Ended,
        SessionEvent.Reasoning.Ended,
        SessionEvent.Tool.Input.Started,
        SessionEvent.Tool.Success,
        SessionEvent.Tool.Failed,
        SessionEvent.InboxEnqueued,
        SessionEvent.Synthetic,
      ])
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === SessionEvent.GoalCleared.type) {
              forget(event.data.sessionID)
              return
            }
            if (event.type === SessionEvent.GoalUpdated.type) {
              const goal = event.data.goal
              const previous = seen.get(goal.sessionID)
              seen.set(goal.sessionID, goal)
              const current = track(goal)
              const created = previous === undefined || previous.goalID !== goal.goalID
              const resumed = previous !== undefined && previous.goalID === goal.goalID && previous.status !== "active"
              const objectiveChanged =
                previous !== undefined && previous.goalID === goal.goalID && previous.objective !== goal.objective
              const running = executions.get(goal.sessionID)?.running === true
              if (created) {
                const audit = executions.get(goal.sessionID)
                if (audit) {
                  audit.successfulTool = false
                  audit.failedShell = false
                }
              }
              if (running) yield* beginCharging(goal)
              if (goal.status !== "active") return
              if (resumed) {
                current.emptyStreak = 0
                current.execFailureStreak = 0
              }
              if (!created && !resumed && !objectiveChanged) return
              if (running && objectiveChanged) {
                yield* admit({
                  sessionID: goal.sessionID,
                  text: SessionGoalTemplates.objectiveUpdated(goal),
                  kind: "objective_updated",
                })
                return
              }
              if (running) return
              yield* continueIfIdle(goal.sessionID)
              return
            }
            if (event.type === SessionEvent.Execution.Started.type) {
              executions.set(event.data.sessionID, newExecution())
              const goal = yield* goals.get(event.data.sessionID)
              if (goal) yield* beginCharging(goal)
              return
            }
            if (event.type === SessionEvent.Step.Started.type) {
              execution(event.data.sessionID).emptyFinal = true
              const goal = yield* goals.get(event.data.sessionID)
              if (goal) yield* beginCharging(goal)
              return
            }
            if (event.type === SessionEvent.Text.Ended.type) {
              const audit = execution(event.data.sessionID)
              if (event.data.text.trim().length > 0) {
                audit.hasActivity = true
                audit.emptyFinal = false
                return
              }
              audit.emptyFinal = true
              return
            }
            if (event.type === SessionEvent.Reasoning.Ended.type) {
              if (event.data.text.trim().length > 0) execution(event.data.sessionID).hasActivity = true
              return
            }
            if (event.type === SessionEvent.Tool.Input.Started.type) {
              const audit = execution(event.data.sessionID)
              audit.hasActivity = true
              audit.tools.set(event.data.id, event.data.name)
              return
            }
            if (event.type === SessionEvent.Tool.Success.type) {
              const audit = execution(event.data.sessionID)
              audit.hasActivity = true
              audit.successfulTool = true
              return
            }
            if (event.type === SessionEvent.Tool.Failed.type) {
              const audit = execution(event.data.sessionID)
              audit.hasActivity = true
              if (event.data.executed && audit.tools.get(event.data.id) === "shell") audit.failedShell = true
              return
            }
            if (event.type === SessionEvent.InboxEnqueued.type) {
              const audit = executions.get(event.data.sessionID)
              if (!audit) return
              if (
                event.data.item.type === "synthetic" &&
                isGoalMetadata(event.data.item.payload.metadata, "continuation")
              )
                return
              audit.hasActivity = true
              return
            }
            if (event.type === SessionEvent.Synthetic.type) {
              const audit = executions.get(event.data.sessionID)
              if (!audit) return
              if (!isGoalMetadata(event.data.metadata, "continuation")) audit.hasActivity = true
              return
            }
            if (event.type === SessionEvent.Step.Ended.type) {
              const goal = yield* goals.get(event.data.sessionID)
              const current = goal ? accounting.get(goal.sessionID) : undefined
              if (!goal || !current || current.goalID !== goal.goalID || !current.charging) return
              const updated = yield* goals.account({
                sessionID: event.data.sessionID,
                tokens: Math.trunc(TokenUsage.billed(event.data.tokens)),
              })
              if (!updated || updated.status !== "budget_limited" || goal.status !== "active") return
              const running =
                executions.get(event.data.sessionID)?.running === true ||
                (yield* sessions.active).has(event.data.sessionID)
              if (!running) return
              yield* admit({
                sessionID: event.data.sessionID,
                text: SessionGoalTemplates.budgetLimit(updated),
                kind: "budget_limit",
              })
              return
            }
            if (event.type === SessionEvent.Execution.Interrupted.type) {
              yield* finishCharging(event.data.sessionID)
              executions.delete(event.data.sessionID)
              if (event.data.reason === "user") yield* goals.pauseActive(event.data.sessionID)
              return
            }
            if (event.type === SessionEvent.Execution.Failed.type) {
              yield* finishCharging(event.data.sessionID)
              executions.delete(event.data.sessionID)
              if (usageLimited(event.data.error.type)) yield* goals.usageLimitActive(event.data.sessionID)
              return
            }
            if (event.type !== SessionEvent.Execution.Succeeded.type) return
            const audit = executions.get(event.data.sessionID)
            const goal = yield* finishCharging(event.data.sessionID)
            executions.delete(event.data.sessionID)
            if (!goal || goal.status !== "active" || !audit) return
            const current = track(goal)
            const execFailed = audit.failedShell && !audit.successfulTool
            if (execFailed) {
              current.execFailureStreak += 1
              if (current.execFailureStreak >= 3) {
                yield* goals.blockActive(event.data.sessionID)
                return
              }
            }
            if (!execFailed) current.execFailureStreak = 0
            const empty = current.lastContinuation && audit.emptyFinal && !audit.hasActivity
            current.lastContinuation = false
            if (empty) {
              current.emptyStreak += 1
              if (current.emptyStreak >= 3) {
                yield* goals.blockActive(event.data.sessionID)
                return
              }
            }
            if (!empty) current.emptyStreak = 0
            yield* continueIfIdle(event.data.sessionID)
          }).pipe(Effect.catch(() => Effect.void)),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const active = yield* goals.listActive()
        yield* Effect.forEach(active, (goal) => continueIfIdle(goal.sessionID), {
          discard: true,
          concurrency: "unbounded",
        })
      }),
    )

    return Service.of({ continueIfIdle })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Bus.node, SessionGoal.node, Session.node, SessionStore.node],
})
