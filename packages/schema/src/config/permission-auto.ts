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
    description: "Additional actions the automatic permission reviewer must block",
  }),
  allow: Schema.String.pipe(Schema.Array, optional).annotate({
    description: "Additional narrow exceptions the automatic permission reviewer may allow",
  }),
  prompt_injection_probe: Schema.Boolean.pipe(optional).annotate({
    description: "Screen textual tool results for prompt injection while reviewed auto mode is active",
  }),
}) {}
