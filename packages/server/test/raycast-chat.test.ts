import { expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { RaycastChatInput, RaycastChatPath } from "@opencode/protocol/groups/generate"
import { ServerAuth } from "../src/auth"
import { authorizedRequest } from "../src/middleware/authorization"
import { forward, sessionID } from "../src/raycast-chat"

const input = RaycastChatInput.make({ model: "oc3-deepseek-v4.1-flash-max", messages: [{ role: "user", content: "first question" }] })
const read = (endpoint: string, payload = input) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const response = yield* forward(payload, "fixture-key", endpoint)
  const web = HttpServerResponse.toWeb(response)
  return { status: web.status, type: web.headers.get("content-type"), text: yield* Effect.promise(() => web.text()) }
})))

test("forwards real HTTP with roles, maximum effort, and Go authentication", async () => {
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    expect(request.headers.get("authorization")).toBe("Bearer fixture-key")
    expect(request.headers.get("user-agent")).toBe("oc3-raycast/1.0")
    expect(request.headers.get("x-opencode-session")).toBe(sessionID(input))
    const body = await request.json()
    expect(body.model).toBe("deepseek-v4.1-flash")
    expect(body.reasoning_effort).toBe("max")
    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.messages).toEqual(input.messages)
    expect(body.tools).toBeUndefined()
    return Response.json({ choices: [{ message: { content: "answer" } }] })
  } })
  try {
    const result = await read(server.url.href)
    expect(result.status).toBe(200)
    expect(JSON.parse(result.text).choices[0].message.content).toBe("answer")
  } finally { await server.stop(true) }
})

test("preserves upstream SSE bytes, including reasoning and completion sentinel", async () => {
  const frame = 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\ndata: [DONE]\n\n'
  const server = Bun.serve({ port: 0, fetch: () => new Response(frame, { headers: { "content-type": "text/event-stream" } }) })
  try {
    const result = await read(server.url.href, { ...input, stream: true })
    expect(result.type).toContain("text/event-stream")
    expect(result.text).toBe(frame)
  } finally { await server.stop(true) }
})

test("redacts upstream credential and quota error bodies", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("private fixture-key diagnostic", { status: 429 }) })
  try {
    const result = await read(server.url.href)
    expect(result.status).toBe(502)
    expect(result.text).not.toContain("fixture-key")
    expect(result.text).not.toContain("private")
  } finally { await server.stop(true) }
})

test("keeps routing affinity stable across followups and text-part representations", () => {
  const followup = { ...input, messages: [...input.messages, { role: "assistant" as const, content: "answer" }, { role: "user" as const, content: "followup" }] }
  expect(sessionID(followup)).toBe(sessionID(input))
  expect(sessionID({ ...input, messages: [{ role: "user", content: [{ type: "text", text: "first question" }] }] })).toBe(sessionID(input))
  expect(sessionID({ ...input, messages: [{ role: "user", content: "different" }] })).not.toBe(sessionID(input))
})

test("rejects unrelated models, images, tools, and empty histories", () => {
  const decode = Schema.decodeUnknownOption(RaycastChatInput)
  expect(Option.isNone(decode({ ...input, model: "different" }))).toBe(true)
  expect(Option.isNone(decode({ ...input, tools: [{}] }))).toBe(true)
  expect(Option.isNone(decode({ ...input, messages: [] }))).toBe(true)
  expect(Option.isNone(decode({ ...input, messages: [{ role: "user", content: [{ type: "image_url", image_url: {} }] }] }))).toBe(true)
})

test("Raycast bearer token cannot access other server routes or survive password rotation", async () => {
  const config = { username: "opencode", password: Option.some("server-secret") }
  const token = ServerAuth.raycastToken("server-secret")
  const request = (path: string, method = "POST", bearer = token) => HttpServerRequest.fromWeb(new Request("http://localhost" + path, { method, headers: { Authorization: "Bearer " + bearer } }))
  expect(await Effect.runPromise(authorizedRequest(request(RaycastChatPath), config))).toBe(true)
  expect(await Effect.runPromise(authorizedRequest(request("/api/session"), config))).toBe(false)
  expect(await Effect.runPromise(authorizedRequest(request(RaycastChatPath, "GET"), config))).toBe(false)
  expect(await Effect.runPromise(authorizedRequest(request(RaycastChatPath, "POST", "server-secret"), config))).toBe(false)
  expect(await Effect.runPromise(authorizedRequest(request(RaycastChatPath), { ...config, password: Option.some("rotated") }))).toBe(false)
})
