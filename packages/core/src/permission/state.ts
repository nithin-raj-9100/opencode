export * as PermissionAutoState from "./state.js"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import type { Permission } from "@opencode/schema/permission"

type SessionID = Permission.Request["sessionID"]

type Classifier = (request: Permission.Request) => Effect.Effect<Permission.Review>

export interface Interface {
  readonly isActive: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly activate: (sessionID: SessionID) => Effect.Effect<void>
  readonly deactivate: (sessionID: SessionID) => Effect.Effect<void>
  readonly bindClassifier: (classify: Classifier | undefined) => Effect.Effect<void>
  readonly classify: (request: Permission.Request) => Effect.Effect<Permission.Review | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionAutoState") {}

// Broad shell allows that grant arbitrary code execution. Auto mode suspends
// these even when the user configured them, because they would bypass the
// classifier for exactly the commands most capable of causing damage.
const INTERPRETERS = new Set([
  "python",
  "python2",
  "python3",
  "node",
  "nodejs",
  "ruby",
  "bun",
  "deno",
  "bash",
  "sh",
  "zsh",
  "fish",
  "pwsh",
  "powershell",
  "perl",
  "php",
  "osascript",
])
const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx", "corepack", "uvx", "pipx"])
const PACKAGE_RUN_SUBCOMMANDS = new Set(["run", "exec", "dlx", "x", "create", "init"])
const COMMAND_WRAPPERS = new Set(["env", "command", "timeout", "nice", "nohup", "time", "xargs", "stdbuf"])
const INLINE_PAYLOAD_FLAG = /^-{1,2}(?:[a-zA-Z]*[ce]|eval|command)$/i

/** Splits a rule resource into command tokens, dropping env assignments and wrappers. */
function commandTokens(resource: string) {
  const tokens = resource
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "")
    .split(/\s+/)
  for (let index = 0; index < 8; index++) {
    const head = /^[A-Za-z][\w.-]*/.exec(tokens[0] ?? "")?.[0]?.toLowerCase()
    if (!head || !COMMAND_WRAPPERS.has(head)) break
    tokens.splice(0, 1)
    while (tokens[0] && (/^\d/.test(tokens[0]) || tokens[0].startsWith("-"))) tokens.splice(0, 1)
  }
  return tokens
}

function isBroadExecutionAllow(resource: string) {
  const tokens = commandTokens(resource)
  const head = /^[A-Za-z][\w.-]*/.exec(tokens[0] ?? "")?.[0]?.toLowerCase() ?? ""
  if (!head) return (tokens[0] ?? "").startsWith("*")
  const next = tokens[1]
  const wildcard = next === undefined || next.startsWith("*") || next.replace(/\*+$/, "") === ""
  if (PACKAGE_RUNNERS.has(head)) {
    if (wildcard) return true
    if (next && PACKAGE_RUN_SUBCOMMANDS.has(next.replace(/\*+$/, "").toLowerCase())) return true
    if (next && next.startsWith("-") && resource.includes("*")) return true
  }
  if (INTERPRETERS.has(head)) {
    if (wildcard) return true
    if (next && INLINE_PAYLOAD_FLAG.test(next) && resource.includes("*")) return true
  }
  return false
}

export function isDangerousAllow(action: string, resource: string) {
  if (action === "monitor") return true
  if (action === "subagent" || action === "agent") return true
  if (action !== "shell" && action !== "bash") return false
  if (resource === "*" || resource === "Bash(*)" || resource === "shell(*)") return true
  return isBroadExecutionAllow(resource)
}

export function shouldStripAllow(
  action: string,
  resource: string,
  classifyAllShell: boolean,
) {
  if (action === "*" && resource === "*") return true
  if (isDangerousAllow(action, resource)) return true
  if ((action === "edit" || action === "write" || action === "patch") && resource === "*") return true
  if (classifyAllShell && (action === "shell" || action === "bash")) return true
  return false
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const active = new Set<SessionID>()
    let classifier: Classifier | undefined
    const isActive: Interface["isActive"] = (sessionID) => Effect.succeed(active.has(sessionID))
    const activate: Interface["activate"] = (sessionID) => Effect.sync(() => void active.add(sessionID))
    const deactivate: Interface["deactivate"] = (sessionID) => Effect.sync(() => void active.delete(sessionID))
    const bindClassifier: Interface["bindClassifier"] = (classify) =>
      Effect.sync(() => {
        classifier = classify
      })
    const classify: Interface["classify"] = (request) => (classifier ? classifier(request) : Effect.succeed(undefined))
    return Service.of({ isActive, activate, deactivate, bindClassifier, classify })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
