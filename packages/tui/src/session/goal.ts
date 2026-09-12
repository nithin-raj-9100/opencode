import { SessionGoal } from "@opencode/schema/session-goal"

export const GOAL_USAGE = "Usage: /goal [<objective>|clear|edit|pause|resume]"
export const GOAL_USAGE_HINT = "Example: /goal improve benchmark coverage"
export const TIME_LIMIT_HINT = "Time-limited goals are not supported yet."
export const LOOP_HINT = "Recurring work belongs to /loop, not /goal."

export type GoalView = {
  readonly objective: string
  readonly status: SessionGoal.Status
  readonly tokenBudget?: number
  readonly tokensUsed: number
  readonly timeUsedSeconds: number
}

export function parseGoalArgs(input: string | undefined) {
  const text = input?.trim() ?? ""
  if (!text) return { _tag: "summary" as const }
  const lower = text.toLowerCase()
  if (lower === "clear") return { _tag: "clear" as const }
  if (lower === "edit") return { _tag: "edit" as const }
  if (lower === "pause") return { _tag: "pause" as const }
  if (lower === "resume") return { _tag: "resume" as const }
  if (/^every\b/i.test(text)) return { _tag: "loop" as const }
  const timed = text.match(/^(\d+[mh])\s+([\s\S]+)$/i)
  const parsed = SessionGoal.parseObjective(timed ? timed[2].trim() : text)
  if (parsed._tag !== "ok") return parsed
  return { _tag: "set" as const, objective: parsed.objective, timeLimited: Boolean(timed) }
}

export function shouldConfirmReplace(goal: GoalView | undefined) {
  return goal !== undefined && SessionGoal.unfinished(goal.status)
}

export function statusLabel(status: SessionGoal.Status) {
  if (status === "active") return "active"
  if (status === "paused") return "paused"
  if (status === "blocked") return "stalled"
  if (status === "usage_limited") return "usage limited"
  if (status === "budget_limited") return "limited by budget"
  return "complete"
}

export function formatElapsed(seconds: number) {
  const value = Math.max(0, Math.trunc(seconds))
  if (value < 60) return `${value}s`
  const minutes = Math.floor(value / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h ${remainingMinutes}m`
  }
  if (remainingMinutes === 0) return `${hours}h`
  return `${hours}h ${remainingMinutes}m`
}

export function formatTokensCompact(value: number) {
  const tokens = Math.max(0, Math.trunc(value))
  if (tokens === 0) return "0"
  if (tokens < 1000) return String(tokens)
  const scaled =
    tokens >= 1_000_000_000_000
      ? tokens / 1_000_000_000_000
      : tokens >= 1_000_000_000
        ? tokens / 1_000_000_000
        : tokens >= 1_000_000
          ? tokens / 1_000_000
          : tokens / 1000
  const suffix =
    tokens >= 1_000_000_000_000 ? "T" : tokens >= 1_000_000_000 ? "B" : tokens >= 1_000_000 ? "M" : "K"
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0
  const raw = scaled.toFixed(decimals)
  const formatted = raw.includes(".") ? raw.replace(/0+$/, "").replace(/\.$/, "") : raw
  return `${formatted}${suffix}`
}

export function editedGoalStatus(status: SessionGoal.Status) {
  if (status === "complete" || status === "budget_limited") return "active"
  return status
}

export function usageSummary(goal: GoalView) {
  const parts = [`Objective: ${goal.objective}`]
  if (goal.timeUsedSeconds > 0) parts.push(`Time: ${formatElapsed(goal.timeUsedSeconds)}.`)
  if (goal.tokenBudget !== undefined)
    parts.push(`Tokens: ${formatTokensCompact(goal.tokensUsed)}/${formatTokensCompact(goal.tokenBudget)}.`)
  return parts.join(" ")
}

export function summaryLines(goal: GoalView) {
  const commands =
    goal.status === "active"
      ? "Commands: /goal edit, /goal pause, /goal clear"
      : goal.status === "paused" || goal.status === "blocked" || goal.status === "usage_limited"
        ? "Commands: /goal edit, /goal resume, /goal clear"
        : "Commands: /goal edit, /goal clear"
  const lines = [
    `Status: ${statusLabel(goal.status)}`,
    `Objective: ${goal.objective}`,
    `Time used: ${formatElapsed(goal.timeUsedSeconds)}`,
    `Tokens used: ${formatTokensCompact(goal.tokensUsed)}`,
  ]
  if (goal.tokenBudget !== undefined) lines.push(`Token budget: ${formatTokensCompact(goal.tokenBudget)}`)
  lines.push("", commands)
  return lines
}

export function goalCommandText(objective: string) {
  return `/goal ${objective}`
}

export function liveTimeUsedSeconds(input: {
  status: SessionGoal.Status
  tokenBudget?: number
  timeUsedSeconds: number
  running: boolean
  chargingStartedAt: number | undefined
  now: number
}) {
  if (input.status !== "active") return input.timeUsedSeconds
  if (input.tokenBudget !== undefined) return input.timeUsedSeconds
  if (!input.running || input.chargingStartedAt === undefined) return input.timeUsedSeconds
  return input.timeUsedSeconds + Math.max(0, Math.floor((input.now - input.chargingStartedAt) / 1000))
}

export function nextChargingStartedAt(input: {
  sessionID: string
  status: SessionGoal.Status
  tokenBudget?: number
  running: boolean
  timeUsedSeconds: number
  previous:
    | {
        sessionID: string
        timeUsedSeconds: number
        startedAt: number
      }
    | undefined
  now: number
}) {
  if (input.status !== "active" || input.tokenBudget !== undefined || !input.running) return
  if (input.previous?.sessionID === input.sessionID && input.previous.timeUsedSeconds === input.timeUsedSeconds)
    return input.previous.startedAt
  return input.now
}

export function footerLabel(goal: GoalView) {
  if (goal.status === "active") {
    if (goal.tokenBudget !== undefined)
      return `Pursuing goal (${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)})`
    return `Pursuing goal (${formatElapsed(goal.timeUsedSeconds)})`
  }
  if (goal.status === "paused") return "Goal paused (/goal resume)"
  if (goal.status === "blocked") return "Goal stalled (/goal resume)"
  if (goal.status === "usage_limited") return "Goal hit usage limits (/goal resume)"
  if (goal.status === "budget_limited") {
    if (goal.tokenBudget === undefined) return "Goal abandoned"
    return `Goal unmet (${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)} tokens)`
  }
  return `Goal achieved (${
    goal.tokenBudget !== undefined ? `${formatTokensCompact(goal.tokensUsed)} tokens` : formatElapsed(goal.timeUsedSeconds)
  })`
}

export function footerFeedback(status: SessionGoal.Status) {
  if (status === "complete") return "success" as const
  if (status === "active") return "info" as const
  return "warning" as const
}

export function resumeStatuses(status: SessionGoal.Status) {
  return status === "paused" || status === "blocked" || status === "usage_limited"
}
