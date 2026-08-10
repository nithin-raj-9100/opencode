export * as ConfigSessionPeer from "./session-peer"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("Config.SessionPeer")({
  inbound: Schema.Literals(["accept", "refuse"]).pipe(Schema.optional),
}) {}
