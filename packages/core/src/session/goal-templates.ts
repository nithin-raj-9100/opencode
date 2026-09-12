export * as SessionGoalTemplates from "./goal-templates.js"

import { SessionGoal } from "@opencode/schema/session-goal"
import continuationTemplate from "./goal/continuation.md"
import budgetLimitTemplate from "./goal/budget-limit.md"
import objectiveUpdatedTemplate from "./goal/objective-updated.md"

const escapeXml = (input: string) => input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const render = (template: string, vars: Record<string, string>) =>
  template.replaceAll(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "")

const budgetVars = (goal: SessionGoal.Info) => {
  const remaining = SessionGoal.remainingTokens(goal)
  return {
    objective: escapeXml(goal.objective),
    tokens_used: String(goal.tokensUsed),
    token_budget: goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget),
    remaining_tokens: remaining === undefined ? "unbounded" : String(remaining),
    time_used_seconds: String(goal.timeUsedSeconds),
  }
}

export const continuation = (goal: SessionGoal.Info) => render(continuationTemplate, budgetVars(goal))

export const budgetLimit = (goal: SessionGoal.Info) => render(budgetLimitTemplate, budgetVars(goal))

export const objectiveUpdated = (goal: SessionGoal.Info) => {
  const vars = budgetVars(goal)
  return render(objectiveUpdatedTemplate, {
    ...vars,
    remaining_tokens: vars.token_budget === "none" ? "unknown" : vars.remaining_tokens,
  })
}
