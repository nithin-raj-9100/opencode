import { EOL } from "os"
import { Effect } from "effect"
import { OpenCode } from "@opencode-ai/client"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "@opencode-ai/client/effect/service"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  Commands.commands["auto-mode"].commands.config,
  Effect.fn("cli.auto-mode.config")(function* () {
    const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const response = yield* Effect.promise(() =>
      client.permission.auto_config({ location: { directory: process.cwd() } }),
    )
    process.stdout.write(JSON.stringify(response.data, null, 2) + EOL)
  }),
)
