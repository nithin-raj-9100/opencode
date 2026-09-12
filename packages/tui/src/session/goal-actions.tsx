import type { OpenCodeClient } from "@opencode/client"
import type { SessionGoalInfo } from "@opencode/client"
import { SessionGoal } from "@opencode/schema/session-goal"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import type { DialogContext } from "../ui/dialog"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"
import {
  GOAL_USAGE,
  GOAL_USAGE_HINT,
  LOOP_HINT,
  TIME_LIMIT_HINT,
  editedGoalStatus,
  parseGoalArgs,
  resumeStatuses,
  shouldConfirmReplace,
  statusLabel,
  summaryLines,
  usageSummary,
  type GoalView,
} from "./goal"

type Toast = {
  show: (options: { title?: string; message: string; variant: "info" | "success" | "warning" | "error" }) => void
  error: (error: unknown) => void
}

export function runSessionGoal(input: {
  sessionID: string
  args: string | undefined
  api: OpenCodeClient
  goal: GoalView | undefined
  sessionTitle: string | undefined
  dialog: DialogContext
  toast: Toast
  prepare?: () => Promise<void>
}) {
  const parsed = parseGoalArgs(input.args)
  if (parsed._tag === "loop") {
    input.toast.show({ message: LOOP_HINT, variant: "warning" })
    return
  }
  if (parsed._tag === "empty" || parsed._tag === "too_long") {
    input.toast.show({
      message:
        parsed._tag === "too_long"
          ? `Goal objective is ${parsed.actual} characters; the limit is ${parsed.max} characters`
          : GOAL_USAGE,
      variant: "error",
    })
    return
  }
  if (parsed._tag === "summary") {
    showGoalSummary(input)
    return
  }
  if (parsed._tag === "clear") {
    void clearGoal(input)
    return
  }
  if (parsed._tag === "edit") {
    showGoalEditor(input)
    return
  }
  if (parsed._tag === "pause" || parsed._tag === "resume") {
    if (!input.goal) {
      input.toast.show({ message: "No goal is currently set.", variant: "error" })
      return
    }
    void setGoalStatus(input, parsed._tag === "pause" ? "paused" : "active")
    return
  }
  if (parsed.timeLimited) input.toast.show({ message: TIME_LIMIT_HINT, variant: "warning" })
  if (shouldConfirmReplace(input.goal)) {
    input.dialog.replace(() => (
      <DialogConfirm
        title="Replace goal?"
        message={`New objective: ${Locale.truncate(parsed.objective, 200)}`}
        label={{ confirm: "Replace", cancel: "Cancel" }}
        onConfirm={() => void replaceGoal(input, parsed.objective)}
      />
    ))
    return
  }
  if (input.goal) {
    void replaceGoal(input, parsed.objective)
    return
  }
  void setGoal(input, { objective: parsed.objective, status: "active" })
}

export function maybePromptResumePausedGoal(input: {
  sessionID: string
  goal: SessionGoalInfo | undefined
  api: OpenCodeClient
  dialog: DialogContext
  toast: Toast
  prompted: Set<string>
  prepare?: () => Promise<void>
}) {
  if (!input.goal || !resumeStatuses(input.goal.status)) return
  const goal = input.goal
  const key = `${input.sessionID}:${goal.goalID}:${goal.status}`
  if (input.prompted.has(key)) return
  input.prompted.add(key)
  input.dialog.replace(() => (
    <DialogConfirm
      title="Resume paused goal?"
      message={`Goal: ${goal.objective}`}
      label={{ confirm: "Resume goal", cancel: "Leave paused" }}
      onConfirm={() => void setGoalStatus(input, "active")}
    />
  ))
}

function showGoalSummary(input: {
  goal: GoalView | undefined
  dialog: DialogContext
}) {
  if (!input.goal) {
    input.dialog.replace(() => (
      <DialogAlert title={GOAL_USAGE} message={`No goal is currently set.\n${GOAL_USAGE_HINT}`} />
    ))
    return
  }
  const goal = input.goal
  input.dialog.replace(() => <DialogAlert title="Goal" message={summaryLines(goal).join("\n")} />)
}

function showGoalEditor(input: {
  sessionID: string
  api: OpenCodeClient
  goal: GoalView | undefined
  dialog: DialogContext
  toast: Toast
}) {
  if (!input.goal) {
    input.toast.show({ message: "No goal is currently set.", variant: "error" })
    input.dialog.replace(() => (
      <DialogAlert title={GOAL_USAGE} message="Create a goal before editing it." />
    ))
    return
  }
  const current = input.goal
  input.dialog.replace(() => (
    <DialogPrompt
      title="Edit goal"
      description={() => <text>Type a goal objective and press Enter</text>}
      value={current.objective}
      onConfirm={(value) => {
        const parsed = SessionGoal.parseObjective(value)
        if (parsed._tag !== "ok") {
          input.toast.show({
            message:
              parsed._tag === "too_long"
                ? `Goal objective is ${parsed.actual} characters; the limit is ${parsed.max} characters`
                : "Goal objective must not be empty",
            variant: "error",
          })
          return
        }
        void setGoal(input, { objective: parsed.objective, status: editedGoalStatus(current.status) })
        input.dialog.clear()
      }}
      onCancel={() => input.dialog.clear()}
    />
  ))
}

async function replaceGoal(
  input: {
    sessionID: string
    api: OpenCodeClient
    sessionTitle?: string
    toast: Toast
    prepare?: () => Promise<void>
  },
  objective: string,
) {
  try {
    await input.prepare?.()
    await input.api.session.goal.clear({ sessionID: input.sessionID })
    await setGoal({ ...input, prepare: undefined }, { objective, status: "active" })
  } catch (error) {
    input.toast.show({ message: `Failed to replace thread goal: ${errorMessage(error)}`, variant: "error" })
  }
}

async function setGoal(
  input: {
    sessionID: string
    api: OpenCodeClient
    sessionTitle?: string
    toast: Toast
    prepare?: () => Promise<void>
  },
  payload: { objective?: string; status?: SessionGoalInfo["status"] },
) {
  try {
    if (payload.status === "active") await input.prepare?.()
    const goal = await input.api.session.goal.set({ sessionID: input.sessionID, ...payload })
    if (!input.sessionTitle?.trim() && payload.objective) {
      await input.api.session.rename({ sessionID: input.sessionID, title: payload.objective }).catch(() => undefined)
    }
    input.toast.show({
      title: `Goal ${statusLabel(goal.status)}`,
      message: usageSummary(goal),
      variant: "info",
    })
  } catch (error) {
    input.toast.show({ message: `Failed to set thread goal: ${errorMessage(error)}`, variant: "error" })
  }
}

async function setGoalStatus(
  input: {
    sessionID: string
    api: OpenCodeClient
    toast: Toast
    prepare?: () => Promise<void>
  },
  status: SessionGoalInfo["status"],
) {
  try {
    if (status === "active") await input.prepare?.()
    const goal = await input.api.session.goal.set({ sessionID: input.sessionID, status })
    input.toast.show({
      title: `Goal ${statusLabel(goal.status)}`,
      message: usageSummary(goal),
      variant: "info",
    })
  } catch (error) {
    input.toast.show({ message: `Failed to update thread goal: ${errorMessage(error)}`, variant: "error" })
  }
}

async function clearGoal(input: { sessionID: string; api: OpenCodeClient; toast: Toast }) {
  try {
    const result = await input.api.session.goal.clear({ sessionID: input.sessionID })
    if (result.cleared) {
      input.toast.show({ message: "Goal cleared", variant: "info" })
      return
    }
    input.toast.show({
      title: "No goal to clear",
      message: "This thread does not currently have a goal.",
      variant: "info",
    })
  } catch (error) {
    input.toast.show({ message: `Failed to clear thread goal: ${errorMessage(error)}`, variant: "error" })
  }
}
