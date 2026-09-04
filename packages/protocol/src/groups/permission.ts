import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Permission } from "@opencode-ai/schema/permission"
import { PermissionSaved } from "@opencode-ai/schema/permission-saved"
import { Project } from "@opencode-ai/schema/project"
import { Session } from "@opencode-ai/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { PermissionNotFoundError, SessionNotFoundError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const makePermissionGroup = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.permission")
    .add(
      HttpApiEndpoint.get("permission.request.list", "/api/permission/request", {
        query: LocationQuery,
        success: Location.response(Schema.Array(Permission.Request)),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.permission.request.list",
            summary: "List pending permission requests",
            description: "Retrieve pending permission requests for a location.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("permission.saved.list", "/api/permission/saved", {
        query: Schema.Struct({ projectID: Project.ID.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Schema.Array(PermissionSaved.Info) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.saved.list",
          summary: "List saved permissions",
          description: "Retrieve saved permissions, optionally filtered by project.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("permission.saved.remove", "/api/permission/saved/:id", {
        params: { id: PermissionSaved.ID },
        success: HttpApiSchema.NoContent,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.saved.remove",
          summary: "Remove saved permission",
          description: "Remove a saved permission by ID.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("permission.auto.defaults", "/api/permission/auto/defaults", {
        query: LocationQuery,
        success: Location.response(
          Schema.Struct({
            allow: Schema.Array(Schema.String),
            soft_deny: Schema.Array(Schema.String),
            hard_deny: Schema.Array(Schema.String),
            environment: Schema.String,
          }),
        ),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.permission.auto_defaults",
            summary: "Get auto mode defaults",
            description: "Return the built-in auto mode classifier rules.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("permission.auto.config", "/api/permission/auto/config", {
        query: LocationQuery,
        success: Location.response(
          Schema.Struct({
            allow: Schema.Array(Schema.String),
            soft_deny: Schema.Array(Schema.String),
            hard_deny: Schema.Array(Schema.String),
            environment: Schema.String,
          }),
        ),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.permission.auto_config",
            summary: "Get effective auto mode config",
            description: "Return the effective auto mode classifier rules with user settings applied.",
          }),
        ),
    )
    // Effect applies group middleware only to endpoints already added; session endpoints use session placement below.
    .middleware(locationMiddleware)
    .add(
      HttpApiEndpoint.put("session.permission.auto", "/api/session/:sessionID/permission/auto", {
        params: { sessionID: Session.ID },
        query: LocationQuery,
        payload: Schema.Struct({ enabled: Schema.Boolean }),
        success: HttpApiSchema.NoContent,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.auto",
            summary: "Set reviewed auto mode",
            description:
              "Enable or disable reviewed auto mode for a session family. Works before the session exists: enabling an unknown session pre-enables its family.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.permission.create", "/api/session/:sessionID/permission", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: Permission.ID.pipe(Schema.optional),
          action: Permission.Request.fields.action,
          resources: Permission.Request.fields.resources,
          save: Permission.Request.fields.save,
          metadata: Permission.Request.fields.metadata,
          source: Permission.Request.fields.source,
          agent: Agent.ID.pipe(Schema.optional),
        }),
        success: Schema.Struct({
          data: Schema.Struct({ id: Permission.ID, effect: Permission.Effect }),
        }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.create",
            summary: "Create permission request",
            description: "Evaluate and, when approval is required, create a permission request for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.permission.list", "/api/session/:sessionID/permission", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(Permission.Request) }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.permission.list",
          summary: "List session permission requests",
          description: "Retrieve pending permission requests owned by a session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.permission.get", "/api/session/:sessionID/permission/:requestID", {
        params: { sessionID: Session.ID, requestID: Permission.ID },
        success: Schema.Struct({ data: Permission.Request }),
        error: [SessionNotFoundError, PermissionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.get",
            summary: "Get permission request",
            description: "Retrieve a pending permission request owned by a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.permission.review", "/api/session/:sessionID/permission/:requestID/review", {
        params: { sessionID: Session.ID, requestID: Permission.ID },
        success: Schema.Struct({ data: Permission.Review }),
        error: [SessionNotFoundError, PermissionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.review",
            summary: "Review pending permission",
            description: "Classify a pending permission using reviewed auto mode without executing the action.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.permission.denials", "/api/session/:sessionID/permission/denials", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({
          data: Schema.Array(
            Schema.Struct({
              request: Permission.Request,
              review: Permission.Review,
              time: Schema.Number,
            }),
          ),
        }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.permission.denials",
          summary: "List auto mode denials",
          description: "Retrieve recent actions the auto mode classifier denied for a session family.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.permission.auto.status", "/api/session/:sessionID/permission/auto/status", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({
          data: Schema.Struct({
            enabled: Schema.Boolean,
            consecutive: Schema.Number,
            total: Schema.Number,
            broken: Schema.Boolean,
          }),
        }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.permission.auto_status",
          summary: "Get auto mode status",
          description: "Retrieve reviewed auto mode state and circuit-breaker counters for a session family.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.permission.reply", "/api/session/:sessionID/permission/:requestID/reply", {
        params: { sessionID: Session.ID, requestID: Permission.ID },
        payload: Schema.Struct({
          reply: Permission.Reply,
          message: Schema.String.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, PermissionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.reply",
            summary: "Reply to pending permission request",
            description: "Respond to a pending permission request owned by a session.",
          }),
        ),
    )
    .annotateMerge(OpenApi.annotations({ title: "permission", description: "Experimental permission routes." }))
