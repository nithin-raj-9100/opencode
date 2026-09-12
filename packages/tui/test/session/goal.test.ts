import { describe, expect, test } from "bun:test"
import {
  editedGoalStatus,
  footerLabel,
  formatElapsed,
  formatTokensCompact,
  parseGoalArgs,
  shouldConfirmReplace,
  statusLabel,
  usageSummary,
} from "../../src/session/goal"

describe("parseGoalArgs", () => {
  test("classifies control verbs and objectives", () => {
    expect(parseGoalArgs(undefined)).toEqual({ _tag: "summary" })
    expect(parseGoalArgs("  ")).toEqual({ _tag: "summary" })
    expect(parseGoalArgs("clear")).toEqual({ _tag: "clear" })
    expect(parseGoalArgs("edit")).toEqual({ _tag: "edit" })
    expect(parseGoalArgs("pause")).toEqual({ _tag: "pause" })
    expect(parseGoalArgs("resume")).toEqual({ _tag: "resume" })
    expect(parseGoalArgs("every morning")).toEqual({ _tag: "loop" })
    expect(parseGoalArgs("30m finish the port")).toEqual({
      _tag: "set",
      objective: "finish the port",
      timeLimited: true,
    })
    expect(parseGoalArgs("Ship the TUI goal harness")).toEqual({
      _tag: "set",
      objective: "Ship the TUI goal harness",
      timeLimited: false,
    })
  })
})

describe("goal display", () => {
  test("formats elapsed time and compact tokens", () => {
    expect(formatElapsed(0)).toBe("0s")
    expect(formatElapsed(59)).toBe("59s")
    expect(formatElapsed(60)).toBe("1m")
    expect(formatElapsed(90 * 60)).toBe("1h 30m")
    expect(formatElapsed(2 * 60 * 60)).toBe("2h")
    expect(formatElapsed(24 * 60 * 60)).toBe("1d 0h 0m")
    expect(formatTokensCompact(0)).toBe("0")
    expect(formatTokensCompact(63876)).toBe("63.9K")
    expect(formatTokensCompact(50000)).toBe("50K")
    expect(formatTokensCompact(100_000)).toBe("100K")
    expect(formatTokensCompact(200_000)).toBe("200K")
    expect(formatTokensCompact(100_000_000)).toBe("100M")
  })

  test("reactivates completed and budget-limited goals when editing", () => {
    expect(editedGoalStatus("complete")).toBe("active")
    expect(editedGoalStatus("budget_limited")).toBe("active")
    expect(editedGoalStatus("paused")).toBe("paused")
    expect(editedGoalStatus("blocked")).toBe("blocked")
    expect(editedGoalStatus("usage_limited")).toBe("usage_limited")
    expect(editedGoalStatus("active")).toBe("active")
  })

  test("labels unfinished goals for replace confirmation and footer copy", () => {
    expect(shouldConfirmReplace({ objective: "x", status: "complete", tokensUsed: 0, timeUsedSeconds: 0 })).toBe(false)
    expect(shouldConfirmReplace({ objective: "x", status: "active", tokensUsed: 0, timeUsedSeconds: 0 })).toBe(true)
    expect(statusLabel("blocked")).toBe("stalled")
    expect(statusLabel("budget_limited")).toBe("limited by budget")
    expect(footerLabel({ objective: "x", status: "paused", tokensUsed: 0, timeUsedSeconds: 0 })).toBe(
      "Goal paused (/goal resume)",
    )
    expect(
      usageSummary({
        objective: "Complete the task",
        status: "budget_limited",
        tokenBudget: 50_000,
        tokensUsed: 63_876,
        timeUsedSeconds: 120,
      }),
    ).toBe("Objective: Complete the task Time: 2m. Tokens: 63.9K/50K.")
  })
})
