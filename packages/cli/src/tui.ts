import { run } from "@opencode-ai/tui"
import { TuiConfig } from "@opencode-ai/tui/config"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"

export function runTui(transport: { url: string; headers: RequestInit["headers"] }) {
  const config = TuiConfig.resolve({}, { terminalSuspend: false })
  const gracefulFetch = createGracefulFetch(transport)
  return run({
    ...transport,
    args: {},
    config,
    fetch: gracefulFetch,
    pluginHost: {
      async start() {},
      async dispose() {},
    },
  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}

function createGracefulFetch(transport: { url: string; headers: RequestInit["headers"] }) {
  let cachedProviders: any = null

  async function fetchV2Providers() {
    if (cachedProviders) return cachedProviders
    try {
      const [pRes, mRes] = await Promise.all([
        fetch(new URL("/api/provider", transport.url), { headers: transport.headers }),
        fetch(new URL("/api/model", transport.url), { headers: transport.headers }),
      ])
      const pData = await pRes.json().catch(() => ({}))
      const mData = await mRes.json().catch(() => ({}))
      const providers: any[] = pData.data ?? []
      const models: any[] = mData.data ?? []

      const map = new Map<string, any>()
      for (const p of providers) {
        map.set(p.id, { ...p, models: {} })
      }
      for (const m of models) {
        const p = map.get(m.providerID)
        if (p) {
          p.models[m.id] = m
        }
      }
      cachedProviders = Array.from(map.values())
      return cachedProviders
    } catch {
      return []
    }
  }

  async function fetchV2Agents() {
    try {
      const aRes = await fetch(new URL("/api/agent", transport.url), { headers: transport.headers })
      const aData = await aRes.json().catch(() => ({}))
      const agents: any[] = aData.data ?? []
      return agents.map((a) => ({
        ...a,
        name: a.name || a.id,
      }))
    } catch {
      return []
    }
  }

  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input, transport.url)
      const path = url.pathname

      if (path === "/config/providers") {
        const providers = await fetchV2Providers()
        return Response.json({ providers, default: {} })
      }

      if (path === "/provider") {
        const providers = await fetchV2Providers()
        return Response.json({
          all: providers,
          connected: providers.map((p: any) => p.id),
          default: {},
        })
      }

      if (path === "/agent") {
        const agents = await fetchV2Agents()
        return Response.json(agents)
      }

      if (path === "/session" && (!init?.method || init.method.toUpperCase() === "GET")) {
        try {
          const sRes = await fetch(new URL("/api/session", transport.url), { headers: transport.headers })
          const sData = await sRes.json().catch(() => ({}))
          return Response.json(sData.data ?? [])
        } catch {
          return Response.json([])
        }
      }

      if (path === "/experimental/capabilities") {
        return Response.json({ backgroundSubagents: true })
      }

      if (path === "/global/event" || path === "/event") {
        return fetch(new URL("/api/event", transport.url), {
          ...init,
          headers: {
            ...init?.headers,
            ...transport.headers,
          },
        })
      }

      if (path.startsWith("/project/") && path.endsWith("/directories")) {
        return Response.json([{ directory: process.cwd() }])
      }

      const legacyDefaults: Record<string, unknown> = {
        "/config": {},
        "/command": [],
        "/experimental/capabilities": { backgroundSubagents: true },
        "/experimental/console": { consoleManagedProviders: [], switchableOrgCount: 0 },
        "/experimental/resource": {},
        "/experimental/workspace": [],
        "/experimental/workspace/status": [],
        "/formatter": [],
        "/lsp": [],
        "/mcp": {},
        "/path": { home: process.env.HOME || "", state: "", config: "", directory: process.cwd() },
        "/project/current": { id: "proj_default", worktree: process.cwd() },
        "/project/sync": {},
        "/provider/auth": {},
        "/session/status": {},
        "/vcs": { branch: "dev" },
      }

      if (legacyDefaults[path] !== undefined) {
        return Response.json(legacyDefaults[path])
      }

      const fetchTarget = input instanceof Request ? input : new URL(input, transport.url)
      const response = await fetch(fetchTarget, init).catch(() => new Response(null, { status: 404 }))
      return response
    },
    { preconnect: fetch.preconnect },
  )
}
