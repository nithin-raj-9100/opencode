export * as PermissionAutoState from "./state.js"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import type { Permission } from "@opencode-ai/schema/permission"

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

const DANGEROUS_SHELL_PATTERNS = ["*", "python*", "node*", "ruby*", "bun*", "deno*", "bash(*", "sh(*"]

export function isDangerousAllow(action: string, resource: string) {
  if (action === "monitor") return true
  if (action === "subagent" || action === "agent") return true
  if (action !== "shell" && action !== "bash") return false
  if (resource === "*" || resource === "Bash(*)" || resource === "shell(*)") return true
  return DANGEROUS_SHELL_PATTERNS.some((pattern) => resource === pattern || resource.startsWith(`${pattern} `))
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
