import { confirm, intro, log, outro } from "@clack/prompts"
import { Effect } from "effect"
import { OpenCode } from "@opencode/client"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "@opencode/client/effect/service"
import { ServiceConfig } from "../../../services/service-config"
import { handlePromptErrors, prompt, requireInteractive } from "../../../ui/prompt"

export default Runtime.handler(
  Commands.commands["auto-mode"].commands.reset,
  Effect.fn("cli.auto-mode.reset")(
    function* (input) {
      const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
      intro("Reset auto mode configuration")
      const effective = yield* Effect.promise(() =>
        client.permission.auto_config({ location: { directory: process.cwd() } }),
      )
      log.info("This removes the permission_auto section from your user settings and restores the built-in rules.")
      log.info(
        `Effective rules: ${effective.data.allow.length} allow, ${effective.data.soft_deny.length} soft deny, ${effective.data.hard_deny.length} hard deny.`,
      )
      if (!input.yes) {
        yield* requireInteractive("Use --yes to reset without an interactive terminal.")
        const accepted = yield* prompt(() =>
          confirm({ message: "Reset auto mode configuration to defaults?", initialValue: false }),
        )
        if (!accepted) {
          outro("Cancelled")
          return
        }
      }
      yield* Effect.promise(() => client.config.update({ permission_auto: null }))
      outro("Auto mode configuration reset")
    },
    (effect) => handlePromptErrors(effect),
  ),
)
