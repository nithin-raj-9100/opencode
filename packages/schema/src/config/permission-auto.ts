export * as ConfigPermissionAuto from "./permission-auto.js"

import { Schema } from "effect"
import { optional } from "../schema.js"
import { ConfigModel } from "./model.js"

export class Info extends Schema.Class<Info>("Config.PermissionAuto")({
  model: ConfigModel.Selection.pipe(optional).annotate({
    description: "Model used for automatic permission reviews; defaults to the active session model",
  }),
  environment: Schema.String.pipe(optional).annotate({
    description: "Trusted services, organizations, and infrastructure available to the permission reviewer",
  }),
  block: Schema.String.pipe(Schema.Array, optional).annotate({
    description: "Additional actions the automatic permission reviewer must block (alias for soft_deny)",
  }),
  soft_deny: Schema.String.pipe(Schema.Array, optional).annotate({
    description: "Destructive actions the classifier blocks unless explicit user intent or an allow exception clears them",
  }),
  hard_deny: Schema.String.pipe(Schema.Array, optional).annotate({
    description: "Unconditional security boundaries inside the classifier; user intent and allow exceptions do not apply",
  }),
  allow: Schema.String.pipe(Schema.Array, optional).annotate({
    description: "Additional narrow exceptions the automatic permission reviewer may allow",
  }),
  classifyAllShell: Schema.Boolean.pipe(optional).annotate({
    description: "Suspend every shell allow rule while auto mode is active so the classifier evaluates all shell commands",
  }),
  classifier: Schema.Literals(["both", "fast", "thinking"]).pipe(optional).annotate({
    description: "Two-stage classifier mode: fast filter only, thinking only, or both (default)",
  }),
  prompt_injection_probe: Schema.Boolean.pipe(optional).annotate({
    description: "Screen textual tool results for prompt injection while reviewed auto mode is active",
  }),
}) {}
