import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { useConfig } from "../config"
import { createSimpleContext } from "./helper"

export type PermissionMode = "auto" | "prompt" | "autoaccept"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const config = useConfig()
    const [store, setStore] = createStore<{ override?: PermissionMode }>({})
    return {
      get mode(): PermissionMode {
        if (store.override) return store.override
        if (args.auto) return "auto"
        return config.data.session.permissions
      },
      set(mode: PermissionMode) {
        setStore("override", mode)
      },
      toggle() {
        const current: PermissionMode = store.override ?? (args.auto ? "auto" : config.data.session.permissions)
        setStore("override", current === "auto" ? "prompt" : "auto")
      },
    }
  },
})
