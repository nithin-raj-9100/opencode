import { EOL } from "os"
import { Effect } from "effect"
import { OpenCode } from "@opencode/client"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "@opencode/client/effect/service"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  Commands.commands["auto-mode"].commands.critique,
  Effect.fn("cli.auto-mode.critique")(function* () {
    const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const response = yield* Effect.promise(() =>
      client.permission.auto_critique({ location: { directory: process.cwd() } }),
    )
    process.stdout.write(response.data.text + EOL)
  }),
)
