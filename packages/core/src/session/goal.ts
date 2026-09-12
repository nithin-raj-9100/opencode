export * as SessionGoal from "./goal.js"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionGoal } from "@opencode/schema/session-goal"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { NotFoundError } from "./error.js"
import { SessionEvent } from "./event.js"
import { SessionSchema } from "./schema.js"
import { SessionGoalTable } from "./sql.js"
import { SessionStore } from "./store.js"

export const Info = SessionGoal.Info
export type Info = SessionGoal.Info
export const Status = SessionGoal.Status
export type Status = SessionGoal.Status
export const AgentStatus = SessionGoal.AgentStatus
export type AgentStatus = SessionGoal.AgentStatus
export const Objective = SessionGoal.Objective
export type Objective = SessionGoal.Objective
export const ID = SessionGoal.ID
export type ID = SessionGoal.ID
export const MaxObjectiveChars = SessionGoal.MaxObjectiveChars
export const remainingTokens = SessionGoal.remainingTokens
export const unfinished = SessionGoal.unfinished
export const parseObjective = SessionGoal.parseObjective

export class InvalidError extends Schema.TaggedError<InvalidError>()("SessionGoal.InvalidError", {
  message: Schema.String,
}) {}

export class UnfinishedError extends Schema.TaggedError<UnfinishedError>()("SessionGoal.UnfinishedError", {
  sessionID: SessionSchema.ID,
  message: Schema.String,
}) {}

export class MissingError extends Schema.TaggedError<MissingError>()("SessionGoal.MissingError", {
  sessionID: SessionSchema.ID,
  message: Schema.String,
}) {}

export type SetInput = {
  readonly sessionID: SessionSchema.ID
  readonly objective?: string
  readonly status?: Status
  readonly tokenBudget?: number | null
}

export type CreateInput = {
  readonly sessionID: SessionSchema.ID
  readonly objective: string
  readonly tokenBudget?: number
}

export type AccountInput = {
  readonly sessionID: SessionSchema.ID
  readonly tokens?: number
  readonly seconds?: number
}

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  readonly listActive: () => Effect.Effect<ReadonlyArray<Info>>
  readonly set: (input: SetInput) => Effect.Effect<Info, NotFoundError | InvalidError | MissingError>
  readonly create: (input: CreateInput) => Effect.Effect<Info, NotFoundError | InvalidError | UnfinishedError>
  readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly pauseActive: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  readonly usageLimitActive: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  readonly blockActive: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  readonly account: (input: AccountInput) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

type Row = typeof SessionGoalTable.$inferSelect

export const fromRow = (row: Row): Info =>
  Info.make({
    sessionID: SessionSchema.ID.make(row.session_id),
    goalID: ID.make(row.goal_id),
    objective: row.objective,
    status: row.status,
    tokenBudget: row.token_budget ?? undefined,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  })

const requireObjective = (value: string) => {
  const parsed = SessionGoal.parseObjective(value)
  if (parsed._tag === "empty") return new InvalidError({ message: "Goal objective must not be empty" })
  if (parsed._tag === "too_long")
    return new InvalidError({
      message: `Goal objective is ${parsed.actual} characters; the limit is ${parsed.max} characters`,
    })
  return parsed.objective
}

const requireBudget = (value: number | undefined) => {
  if (value === undefined) return
  if (!Number.isInteger(value) || value <= 0)
    return new InvalidError({ message: "Goal budgets must be positive when provided" })
  return value
}

const statusAfterBudget = (status: Status, tokensUsed: number, tokenBudget: number | undefined): Status => {
  if (status === "active" && tokenBudget !== undefined && tokensUsed >= tokenBudget) return "budget_limited"
  return status
}

const applyStatus = (current: Status, next: Status, tokensUsed: number, tokenBudget: number | undefined) => {
  if (current === "budget_limited" && (next === "paused" || next === "blocked")) return "budget_limited"
  return statusAfterBudget(next, tokensUsed, tokenBudget)
}

const nowInfo = (input: {
  readonly sessionID: SessionSchema.ID
  readonly goalID: ID
  readonly objective: string
  readonly status: Status
  readonly tokenBudget: number | undefined
  readonly tokensUsed: number
  readonly timeUsedSeconds: number
  readonly created: number
  readonly updated: number
}): Info =>
  Info.make({
    sessionID: input.sessionID,
    goalID: input.goalID,
    objective: input.objective,
    status: input.status,
    tokenBudget: input.tokenBudget,
    tokensUsed: input.tokensUsed,
    timeUsedSeconds: input.timeUsedSeconds,
    time: {
      created: input.created,
      updated: input.updated,
    },
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const locks = yield* KeyedMutex.make<SessionSchema.ID>()

    const requireSession = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* new NotFoundError({ sessionID })
      return session
    })

    const load = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const row = yield* db
        .select()
        .from(SessionGoalTable)
        .where(eq(SessionGoalTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const publishUpdated = (goal: Info) => bus.publish(SessionEvent.GoalUpdated, { sessionID: goal.sessionID, goal })

    const get = Effect.fn("SessionGoal.get")(load)

    const listActive = Effect.fn("SessionGoal.listActive")(function* () {
      const rows = yield* db
        .select()
        .from(SessionGoalTable)
        .where(eq(SessionGoalTable.status, "active"))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const replace = (input: {
      readonly sessionID: SessionSchema.ID
      readonly objective: string
      readonly status: Status
      readonly tokenBudget: number | undefined
    }) => {
      const now = Date.now()
      return nowInfo({
        sessionID: input.sessionID,
        goalID: ID.create(),
        objective: input.objective,
        status: statusAfterBudget(input.status, 0, input.tokenBudget),
        tokenBudget: input.tokenBudget,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        created: now,
        updated: now,
      })
    }

    const patch = (
      existing: Info,
      input: {
        readonly objective?: string
        readonly status?: Status
        readonly tokenBudget?: number | null
      },
    ) => {
      const tokenBudget = input.tokenBudget === undefined ? existing.tokenBudget : (input.tokenBudget ?? undefined)
      const tokensUsed = existing.tokensUsed
      const status =
        input.status === undefined
          ? statusAfterBudget(existing.status, tokensUsed, tokenBudget)
          : applyStatus(existing.status, input.status, tokensUsed, tokenBudget)
      return nowInfo({
        sessionID: existing.sessionID,
        goalID: existing.goalID,
        objective: input.objective ?? existing.objective,
        status,
        tokenBudget,
        tokensUsed,
        timeUsedSeconds: existing.timeUsedSeconds,
        created: existing.time.created,
        updated: Date.now(),
      })
    }

    const set = Effect.fn("SessionGoal.set")(function* (input: SetInput) {
      yield* requireSession(input.sessionID)
      const objective = input.objective === undefined ? undefined : requireObjective(input.objective)
      if (objective instanceof InvalidError) return yield* objective
      const tokenBudget =
        input.tokenBudget === undefined || input.tokenBudget === null ? input.tokenBudget : requireBudget(input.tokenBudget)
      if (tokenBudget instanceof InvalidError) return yield* tokenBudget
      if (objective === undefined && input.status === undefined && input.tokenBudget === undefined)
        return yield* new InvalidError({ message: "Goal update requires an objective, status, or token budget" })
      return yield* locks.withLock(input.sessionID)(
        Effect.gen(function* () {
          const existing = yield* load(input.sessionID)
          if (objective !== undefined && !existing) {
            const created = replace({
              sessionID: input.sessionID,
              objective,
              status: input.status ?? "active",
              tokenBudget: tokenBudget === null ? undefined : tokenBudget,
            })
            yield* publishUpdated(created)
            return created
          }
          if (!existing)
            return yield* new MissingError({
              sessionID: input.sessionID,
              message: "cannot update goal because this session has no goal",
            })
          const updated = patch(existing, { objective, status: input.status, tokenBudget })
          yield* publishUpdated(updated)
          return updated
        }),
      )
    })

    const create = Effect.fn("SessionGoal.create")(function* (input: CreateInput) {
      yield* requireSession(input.sessionID)
      const objective = requireObjective(input.objective)
      if (objective instanceof InvalidError) return yield* objective
      const tokenBudget = requireBudget(input.tokenBudget)
      if (tokenBudget instanceof InvalidError) return yield* tokenBudget
      return yield* locks.withLock(input.sessionID)(
        Effect.gen(function* () {
          const existing = yield* load(input.sessionID)
          if (existing && SessionGoal.unfinished(existing.status))
            return yield* new UnfinishedError({
              sessionID: input.sessionID,
              message:
                "cannot create a new goal because this session has an unfinished goal; complete the existing goal first",
            })
          const created = replace({
            sessionID: input.sessionID,
            objective,
            status: "active",
            tokenBudget,
          })
          yield* publishUpdated(created)
          return created
        }),
      )
    })

    const clear = Effect.fn("SessionGoal.clear")(function* (sessionID: SessionSchema.ID) {
      yield* requireSession(sessionID)
      return yield* locks.withLock(sessionID)(
        Effect.gen(function* () {
          const existing = yield* load(sessionID)
          if (!existing) return false
          yield* bus.publish(SessionEvent.GoalCleared, { sessionID })
          return true
        }),
      )
    })

    const updateActiveStatus = (status: Status) =>
      Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
        return yield* locks.withLock(sessionID)(
          Effect.gen(function* () {
            const existing = yield* load(sessionID)
            if (!existing) return
            if (existing.status !== "active" && !(status === "usage_limited" && existing.status === "budget_limited"))
              return
            const updated = patch(existing, { status })
            yield* publishUpdated(updated)
            return updated
          }),
        )
      })

    const pauseActive = Effect.fn("SessionGoal.pauseActive")(updateActiveStatus("paused"))
    const usageLimitActive = Effect.fn("SessionGoal.usageLimitActive")(updateActiveStatus("usage_limited"))
    const blockActive = Effect.fn("SessionGoal.blockActive")(updateActiveStatus("blocked"))

    const account = Effect.fn("SessionGoal.account")(function* (input: AccountInput) {
      const tokens = Math.max(0, Math.trunc(input.tokens ?? 0))
      const seconds = Math.max(0, Math.trunc(input.seconds ?? 0))
      if (tokens === 0 && seconds === 0) return yield* load(input.sessionID)
      return yield* locks.withLock(input.sessionID)(
        Effect.gen(function* () {
          const existing = yield* load(input.sessionID)
          if (!existing) return
          const tokensUsed = existing.tokensUsed + tokens
          const timeUsedSeconds = existing.timeUsedSeconds + seconds
          const status =
            existing.status === "active" || existing.status === "budget_limited"
              ? statusAfterBudget(existing.status, tokensUsed, existing.tokenBudget)
              : existing.status
          const updated = nowInfo({
            sessionID: existing.sessionID,
            goalID: existing.goalID,
            objective: existing.objective,
            status,
            tokenBudget: existing.tokenBudget,
            tokensUsed,
            timeUsedSeconds,
            created: existing.time.created,
            updated: Date.now(),
          })
          yield* publishUpdated(updated)
          return updated
        }),
      )
    })

    return Service.of({
      get,
      listActive,
      set,
      create,
      clear,
      pauseActive,
      usageLimitActive,
      blockActive,
      account,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, Bus.node, SessionStore.node],
})
