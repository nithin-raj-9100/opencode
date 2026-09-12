export * as GoalTools from "./goal.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { PositiveInt } from "@opencode/schema/schema"
import { Effect, Schema } from "effect"
import { SessionGoal } from "../../session/goal.js"

export const CreateInput = Schema.Struct({
  objective: SessionGoal.Objective.annotate({
    description:
      "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
  }),
  token_budget: Schema.optionalKey(PositiveInt).annotate({
    description: "Positive token budget for the new goal. Omit unless explicitly requested.",
  }),
})

export const UpdateInput = Schema.Struct({
  status: SessionGoal.AgentStatus.annotate({
    description:
      "Required. `paused` requires an explicit user request. Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. After a previously blocked goal is resumed, the resumed run starts a fresh blocked audit.",
  }),
})

const GoalOutput = Schema.Struct({
  goal: Schema.NullOr(SessionGoal.Info),
  remainingTokens: Schema.NullOr(Schema.Int),
  completionBudgetReport: Schema.NullOr(Schema.String),
})

const completionBudgetReport =
  "Goal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language."

const response = (goal: SessionGoal.Info | undefined, complete: boolean) => {
  const remaining = goal ? (SessionGoal.remainingTokens(goal) ?? null) : null
  const report =
    complete && goal && (goal.tokenBudget !== undefined || goal.timeUsedSeconds > 0) ? completionBudgetReport : null
  return {
    output: { goal: goal ?? null, remainingTokens: remaining, completionBudgetReport: report },
    content: goal ? `Goal ${goal.status}.` : "No goal is set.",
  }
}

export const Plugin = {
  id: "opencode.goal",
  effect: Effect.fn("GoalTools.Plugin")(function* (ctx: Context) {
    const goals = yield* SessionGoal.Service
    yield* ctx.tool
      .transform((draft) => {
        draft.add({
          name: "get_goal",
          description:
            "Get the current goal for this session, including status, budgets, token and elapsed-time usage, and remaining token budget.",
          input: Schema.Struct({}),
          output: GoalOutput,
          options: { codemode: false },
          execute: (_input, context) =>
            goals.get(context.sessionID).pipe(
              Effect.map((goal) => response(goal, false)),
              Effect.mapError((error) => new ToolFailure({ message: "failed to read goal", error })),
            ),
        })
        draft.add({
          name: "create_goal",
          description:
            "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
          input: CreateInput,
          output: GoalOutput,
          options: { codemode: false },
          execute: (input, context) =>
            goals
              .create({
                sessionID: context.sessionID,
                objective: input.objective,
                tokenBudget: input.token_budget,
              })
              .pipe(
                Effect.tap((goal) =>
                  ctx.session.get({ sessionID: context.sessionID }).pipe(
                    Effect.flatMap((session) => {
                      if (session.title?.trim()) return Effect.void
                      return ctx.session
                        .rename({ sessionID: context.sessionID, title: goal.objective })
                        .pipe(Effect.catch(() => Effect.void))
                    }),
                    Effect.catch(() => Effect.void),
                  ),
                ),
                Effect.map((goal) => response(goal, false)),
                Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
              ),
        })
        draft.add({
          name: "update_goal",
          description: `Update the existing goal.
Set status to \`paused\` only at the user's explicit request to pause this goal, never on your own initiative. Ask if unclear; a later resume revokes that request. Report the returned status and stop goal work. Budget limits take precedence over pausing.
Set status to \`complete\` only when the objective has actually been achieved and no required work remains.
Set status to \`blocked\` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.
If the user resumes a goal that was previously marked \`blocked\`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to \`blocked\` again.
Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to \`blocked\`.
Do not use \`blocked\` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.
You cannot use this tool to resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.
When marking a budgeted goal achieved with status \`complete\`, report the final token usage from the tool result to the user.`,
          input: UpdateInput,
          output: GoalOutput,
          options: { codemode: false },
          execute: (input, context) =>
            goals.set({ sessionID: context.sessionID, status: input.status }).pipe(
              Effect.map((goal) => response(goal, input.status === "complete")),
              Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}
