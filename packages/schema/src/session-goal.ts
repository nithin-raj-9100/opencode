export * as SessionGoal from "./session-goal.js"

import { Schema } from "effect"
import { descending } from "./identifier.js"
import { NonNegativeInt, optional, PositiveInt, statics } from "./schema.js"
import { SessionID } from "./session-id.js"

export const MaxObjectiveChars = 4000

export const ID = Schema.String.check(Schema.isStartsWith("gol_")).pipe(
  Schema.brand("Session.Goal.ID"),
  statics((schema) => ({
    create: () => schema.make("gol_" + descending()),
  })),
)
export type ID = typeof ID.Type

export const Status = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
]).annotate({ identifier: "Session.Goal.Status" })
export type Status = typeof Status.Type

export const AgentStatus = Schema.Literals(["complete", "blocked", "paused"]).annotate({
  identifier: "Session.Goal.AgentStatus",
})
export type AgentStatus = typeof AgentStatus.Type

export const Objective = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MaxObjectiveChars)).annotate({
  description: "Concrete objective to pursue for this session. At most 4000 characters.",
})
export type Objective = typeof Objective.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  sessionID: SessionID,
  goalID: ID,
  objective: Schema.String,
  status: Status,
  tokenBudget: PositiveInt.pipe(optional),
  tokensUsed: NonNegativeInt,
  timeUsedSeconds: NonNegativeInt,
  time: Schema.Struct({
    created: Schema.Finite,
    updated: Schema.Finite,
  }),
}).annotate({ identifier: "Session.Goal.Info" })

export const Set = Schema.Struct({
  objective: Schema.String.pipe(optional),
  status: Status.pipe(optional),
  tokenBudget: Schema.NullOr(PositiveInt).pipe(optional),
}).annotate({ identifier: "Session.Goal.Set" })
export interface Set extends Schema.Schema.Type<typeof Set> {}

export function unfinished(status: Status) {
  return status !== "complete"
}

export function remainingTokens(goal: Pick<Info, "tokenBudget" | "tokensUsed">) {
  if (goal.tokenBudget === undefined) return
  return Math.max(0, goal.tokenBudget - goal.tokensUsed)
}

export function parseObjective(value: string) {
  const objective = value.trim()
  if (!objective) return { _tag: "empty" as const }
  if (objective.length > MaxObjectiveChars)
    return {
      _tag: "too_long" as const,
      actual: objective.length,
      max: MaxObjectiveChars,
    }
  return { _tag: "ok" as const, objective }
}
