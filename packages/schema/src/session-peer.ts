export * as SessionPeer from "./session-peer"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, statics } from "./schema"
import { SessionID } from "./session-id"
import { ascending } from "./identifier"

export const ID = Schema.String.check(Schema.isStartsWith("msg_")).pipe(
  Schema.brand("SessionPeer.ID"),
  statics((schema) => ({ create: () => schema.make("msg_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Ref = Schema.String.pipe(Schema.brand("SessionPeer.Ref"))
export type Ref = typeof Ref.Type

export interface Source extends Schema.Schema.Type<typeof Source> {}
export const Source = Schema.Struct({
  ref: Ref,
  sessionID: SessionID,
  title: Schema.String,
}).annotate({ identifier: "SessionPeer.Source" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  ...Source.fields,
  directory: Schema.String,
  processID: Schema.Int,
  timeUpdated: DateTimeUtcFromMillis,
}).annotate({ identifier: "SessionPeer.Info" })

export interface Message extends Schema.Schema.Type<typeof Message> {}
export const Message = Schema.Struct({
  id: ID,
  sender: Source,
  target: Ref,
  text: Schema.String,
  timeCreated: DateTimeUtcFromMillis,
}).annotate({ identifier: "SessionPeer.Message" })
