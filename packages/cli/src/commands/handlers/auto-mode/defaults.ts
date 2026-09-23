import { EOL } from "os"
import { Effect, Option } from "effect"
import { OpenCode } from "@opencode/client"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "@opencode/client/effect/service"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  Commands.commands["auto-mode"].commands.defaults,
  Effect.fn("cli.auto-mode.defaults")(function* (input) {
    const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const response = yield* Effect.promise(() =>
      client.permission.auto_defaults({ location: { directory: process.cwd() } }),
    )
    const label = Option.getOrUndefined(input.label)?.toLowerCase()
    const matches = (rules: ReadonlyArray<string>) =>
      label === undefined ? rules : rules.filter((rule) => rule.replace(/^\*\*/, "").toLowerCase().startsWith(label))
    const data = response.data
    process.stdout.write(
      JSON.stringify(
        data && {
          ...data,
          allow: matches(data.allow),
          soft_deny: matches(data.soft_deny),
          hard_deny: matches(data.hard_deny),
          environment: matches(data.environment),
        },
        null,
        2,
      ) + EOL,
    )
  }),
)
