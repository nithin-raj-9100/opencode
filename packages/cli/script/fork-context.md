# Fork context: nithin-raj-9100/opencode `v2-dev`

Read this before touching anything. It tells you what this repository is, what is ours
versus upstream's, and what must never be lost.

## What this repo is

`/Users/nithin/.local/share/opencode3/source` is a personal fork of `sst/opencode`.

- `upstream/dev` — the upstream branch. We never write to it; we track it.
- `origin/v2-dev` — our fork branch, on `github.com/nithin-raj-9100/opencode`. This is the
  only branch we publish.
- `v2-dev` (local) — our custom commits **rebased on top of** `upstream/dev`.

The build output is symlinked to `~/.local/bin/opencode3` and the shared service is
restarted from it, so this branch is the user's daily-driver OpenCode binary. A broken
build is not a CI annoyance — it takes away their working tool.

## Why the automation exists

`~/.local/libexec/opencode3-sync-and-build.sh` runs unattended from launchd
(`com.user.opencode3-sync`). Each run: fetch upstream, purge stale build caches,
`reset --hard origin/v2-dev`, rebase onto `upstream/dev`, install, typecheck, build,
push, restart the service.

The goal is that our custom features ride forward onto every upstream commit **without
the user having to sit there**. You are invoked when that goes wrong — a rebase conflict
or a failing typecheck/build. Nobody is watching. Leave the tree in a state where the
rebase is finished, `bun run check` is green, and the work is committed.

## Our custom work (everything else is upstream's)

Six clusters. Run `git diff --stat upstream/dev...HEAD` for the current file list.

### 1. Reviewed auto mode — the big one

An LLM-classifier permission layer that reviews each tool request instead of blanket
auto-approving, with a hardened two-stage classifier.

- `packages/core/src/permission/auto.ts` — the classifier: decision gate, critical
  paths, JSONL transcript, prompt, two-stage run, denials, hand-back review, probe.
- `packages/core/src/permission/auto-rules.ts` — OpenCode's default rules: 15 allow,
  66 soft_deny (each with a `must name` consent clause), 1 hard_deny, 21 environment.
  Keep labels and `must name` clauses stable; denial messages and user settings use them.
- `packages/core/src/permission/state.ts` — active sessions, classifier binding, and
  broad-allow suspension (blanket shell, interpreters, package-manager runs).
- `packages/core/src/permission.ts` — decision order; configured deny rules win over
  saved approvals.
- `packages/schema/src/config/permission-auto.ts` — config surface: `model`,
  `environment` (string or array of entries), `block`/`soft_deny`, `hard_deny`, `allow`,
  `classifyAllShell`, `classifier` (`both` | `fast` | `thinking`),
  `prompt_injection_probe`, `disableAutoMode`.
- `packages/schema/src/config.ts` (`Config.Patch` carries `permission_auto` so
  `auto-mode reset` can remove it), `packages/schema/src/permission.ts`
- `packages/protocol/src/groups/permission.ts` + `packages/protocol/openapi.json`
- `packages/server/src/handlers/permission.ts`
- `packages/client/**` — generated + effect/promise/solid clients
- `packages/cli/src/commands/handlers/auto-mode/{defaults,config,critique,reset}.ts` and
  their wiring in `commands.ts` / `index.ts`
- `packages/cli/src/run/noninteractive.ts` — `opencode run --auto` denies anything that
  needs a human (including subagent sessions) and keeps running
- `packages/core/src/{config,generate,instance,session/model-request,session/subagent-job,tool/plugin/subagent,tool/plugin/shell,tool/mcp}.ts`,
  `packages/core/src/plugin/{host,internal}.ts`
- TUI: `packages/tui/src/context/permission.tsx` (mode cycle),
  `packages/tui/src/component/prompt/{index,metadata}.tsx` (`auto` / `accept` tags),
  `packages/tui/src/routes/session/index.tsx` (auto sync, `/denials`), `app.tsx`,
  `config/index.tsx` (`session.permissions: "auto"`), `config/keybind.ts`
- Tests: `packages/core/test/permission-auto.test.ts`, `permission.test.ts`,
  `permission-auto-service.test.ts`
- Docs: `packages/web/src/content/docs/permissions.mdx`

Design points worth preserving:

- Decision order, first match wins: configured deny → reads and file edits (read, grep,
  glob, list, external folders, edit, write, patch on any path, including `.env`,
  `~/.zshrc`, temp dirs, and OpenCode config; ask rules on them are ignored; never
  classified) → content-scoped ask rule (a human prompt; blanket `*` asks go to the
  classifier) → critical-path `rm` (classifier even when allowed) → surviving allow rule →
  classifier. There is no shell read-only or help fast path; shell without an allow rule
  is always classified.
- Critical paths: root, top-level dirs, home, the working directory and its parents,
  unguarded `$VAR/*`.
- Classifier input is a reasoning-blind JSONL transcript: `{"user":…}`, the assistant
  prose right before a user reply, per-tool projections (shell command + workdir, edit
  removes/adds, write content, subagent prompt, MCP args), outcome lines, and
  `{"meta":{"gitStatus":…}}` before destructive commands. The action is the last line.
  Instruction files (AGENTS.md) go in `<user_instructions>`; subagent sessions
  get `delegated_task` plus the root session's forwarded user messages. Tool results are
  never included.
- Two stages share one cached system prompt: stage 1 `<block>yes|no`, stage 2 reasons in
  `<thinking>` then `<block>yes</block><category>…</category><reason>[Label] …</reason>`.
  Unparseable, unavailable (with a category), and refused requests are no-verdict denials
  that never count toward limits; 10 in a row stop the turn, with backoff between them.
- Denials name the rule, say hard vs soft and the rule's must-name clause. 3 consecutive or
  20 total blocks (per session) pause to a human prompt; approving resumes. Re-enabling auto
  mode does not reset the counters.
- Broad allow rules are suspended while auto mode is active: blanket shell, wildcarded
  interpreters (`bun *`, `python *`, `node *`, `sh -c *`), package-manager
  `run`/`exec`/`dlx` commands, env/wrapper stubs (`env bun *`, `GIT_EDITOR=true *`),
  subagent allows, and `classifyAllShell` suspends the rest. Narrow rules such as
  `bun install *`, `bun typecheck`, `git *`, or `npm test` carry over. The sync script's
  agent config uses narrow maintenance commands for this reason.
- `permission_auto` merges across every config document outside the project; the
  project's own `permission_auto` is ignored. The classifier uses the session model unless
  `permission_auto.model` is set, falling back to the session model if that fails.
- Subagent reports (foreground and background) get a hand-back review: flagged reports are
  delivered with a security warning, unreviewable ones with a verify note.
- The prompt-injection probe runs only on non-local tool results (shell, web, MCP).
- `disableAutoMode: true` rejects every enable request, including `--auto`.

### 2. Composer and prompt-history behaviour (TUI)

Claude-Code-style composer behaviour that upstream does not have.

- **Take back pending prompts with the up arrow.** `packages/tui/src/prompt/merge.ts`
  (`mergePrompts`) plus `takeBackPending()` in `packages/tui/src/component/prompt/index.tsx`
  and the `hasPendingPrompts` / `takeBackPending` props supplied by
  `packages/tui/src/routes/session/index.tsx`. Pressing up from the first line retracts
  *every* still-pending inbox item, oldest first, one per line, ahead of any text already
  typed. Cancellation is awaited before the composer is touched, because an item the
  runner already promoted cannot be retracted. Tests:
  `packages/tui/test/prompt/merge.test.ts`,
  `packages/tui/test/routes/session/pending-recall.test.tsx`.
  NOTE: mentions carry absolute offsets into `text`, so merging prompts must shift them —
  that is the whole reason `merge.ts` exists.
- **Prompt history is scoped to the working directory.** `packages/tui/src/prompt/history.tsx`
  stores one JSONL file per directory at `<state>/prompt-history/<sha1(directory)>.jsonl`
  instead of a single global file, with `move(scope, …)` / `append(scope, …)` / `ensure(scope)`
  and per-scope cursors. A directory with no file yet is seeded from the legacy global
  `prompt-history.jsonl`. The provider is an app singleton, so the scope is passed per call,
  never captured at mount. Upstream shipped session-scoped history in `fa1b4ef7ec` and
  reverted it in `e0cdf1ed09`; do not "restore global prompt history" when reconciling.
- **Tests must not write to the real state dir.** `packages/tui/test/fixture/app.ts` always
  pins `Global` state to a temp dir, and `packages/tui/test/app-lifecycle.test.tsx` replaces
  `Global.node` for its direct `run()` calls. Without this the suite writes prompt history
  into the user's `~/.local/state/opencode`.

### 3. Prompt navigator (TUI)

Top-right navigator for jumping between user prompts.

- `packages/tui/src/routes/session/prompt-navigator.tsx` (+ its test)
- `packages/tui/src/routes/session/index.tsx` — `PromptNavigator`,
  `promptNavigationIndex`, `isSessionNotFoundError`
- `packages/tui/src/config/keybind.ts` — our bindings differ from upstream on purpose:
  `session.message.user.next`/`previous` are bound to `alt+down`/`alt+up` (upstream:
  `none`), and those combos were consequently **removed** from
  `session.tab.next`/`previous`. Also `permission.denials` (new), `permission.cycle`
  (prompt → accept edits → auto), and the `permission.mode` label "Toggle reviewed auto
  mode".
- `packages/tui/src/mini/stream-v2.*`, `app.tsx`, and TUI test fixtures

### 4. Session `/goal` (TUI + core)

Codex-style long-running session goal. Upstream does not have this. The user sets an
objective with `/goal`; the agent keeps pursuing it across executions until complete,
paused, blocked, or budget/usage limited.

- Schema/events: `packages/schema/src/session-goal.ts`, `session-event.ts`
  (`session.goal.updated` / `session.goal.cleared`). Goal IDs are `gol_`.
- SQL: `session_goal` table, migration `packages/core/src/database/migration/20260912115926_session-goal.ts`
- Core: `packages/core/src/session/goal.ts` (process-global `SessionGoal`, **must not**
  depend on `Session` — cycle), `goal-continuation.ts` (bus subscriber, **not** hooked
  inside `SessionExecution.settled`), templates in `packages/core/src/session/goal/`
- Tools: `packages/core/src/tool/plugin/goal.ts` — native `{ codemode: false }`
  `create_goal` / `update_goal` / `get_goal` in PluginInternal
- HTTP: `GET`/`PUT`/`DELETE /api/session/:sessionID/goal` in protocol + server handlers.
  After protocol/HttpApi changes, regenerate from `packages/client` (`bun run generate`);
  do not hand-edit generated client files. Client `typeReferences` only
  `SessionGoal.Info/Set/Status/ID/AgentStatus` — do not `namespaceTypes` the whole module
  (`Objective` is an unlabeled String and conflicts).
- TUI: slash `session.goal` in `packages/tui/src/routes/session/index.tsx`,
  `packages/tui/src/session/goal.ts` + `goal-actions.tsx`, footer in
  `packages/tui/src/feature-plugins/prompt/footer.tsx`, slash completion in
  `packages/tui/src/prompt/parse.ts` (`completeSlashCommand`) and
  `packages/tui/src/component/prompt/{index,autocomplete}.tsx`
- Tests: `packages/core/test/session-goal.test.ts`, `tool-goal.test.ts`,
  `packages/tui/test/session/goal.test.ts`, `goal-actions.test.ts`,
  `packages/tui/test/prompt/parse.test.ts`, footer + client HTTP/solid-data tests

Architecture that must survive a rebase:

- Durable events are the source of truth; the projector writes `session_goal`.
- Continuation is `Session.synthetic({ delivery: "steer" })` with
  `metadata.source === "goal"`. Wired in `packages/server/src/routes.ts`
  `applicationServiceNodes`.
- **Charging:** enable when an execution starts *and* when a goal becomes
  `active`/`budget_limited` during an already-running execution (create/resume/replace
  mid-run). Keep charging through complete/pause for that execution so in-flight tokens
  and time are not dropped; do not charge later idle executions on a completed goal.
- **Billing:** `TokenUsage.billed` = non-cached `input` + visible `output` + `reasoning`.
  Exclude cache read/write. Do not use `TokenUsage.total`.
- **No-progress:** track activity/tool success/shell failure live from execution start
  (text, reasoning, tools, steers). Do not reconstruct from a 40-message history suffix.
  Three empty automatic continuations or three consecutive shell failures without a
  successful tool → `blocked`. Resuming a blocked goal resets those streaks.
- Edit of `complete`/`budget_limited` restarts as `active` (paused/blocked/usage_limited
  stay). Resume dialog only on session open/switch after goal sync, never on live pause.
- Footer status uses `text.feedback.{info,warning,error,success}` — never raw hues.
- `/goal` commits the composer agent+model before activating.
- **Visible `/goal` prompt:** setting or replacing an objective admits
  `/goal <objective>` as a durable user message via `data.session.prompt`
  (`resume: false`) *then* `session.goal.set`. Control verbs (`clear` /
  `edit` / `pause` / `resume`) and the edit dialog do **not** admit a user
  row. Do not revert to `clearPrompt()` with no transcript message — that
  made the user's prompt vanish. Argument slash submits always
  `history.append` then `resetComposer` (bypass the 20-char draft gate).
- **Autocomplete must not wipe arguments.** `insertSlash` uses
  `completeSlashCommand(name, current)` so `/goal my prompt` stays
  `/goal my prompt` (and `/g my prompt` becomes `/goal my prompt`). If the
  typed text already has arguments, Enter submits instead of replacing the
  composer with `/${name} `.
- **Live footer timer:** persisted `timeUsedSeconds` only advances when an
  execution ends, so an in-flight run would otherwise show
  `Pursuing goal (0s)` forever. While status is `active`, unbudgeted, and
  `session.status === "running"`, add `now - chargingStartedAt`. Keep the
  same window across token-only `GoalUpdated` events; reset it when
  persisted time lands (avoids double-counting); do not add idle time.
  Token-budgeted active goals still show `tokens / budget`, not elapsed
  time. Helpers: `liveTimeUsedSeconds` / `nextChargingStartedAt` in
  `packages/tui/src/session/goal.ts`, ticked from
  `packages/tui/src/feature-plugins/prompt/footer.tsx`.

Deliberate OpenCode differences (do **not** "fix" toward Codex):

- Default fork does **not** copy the goal.
- Oversized objectives are **rejected** (4000 chars), not materialized into files.
- Time-limited prefix (`\d+[mh]\s`) toasts that time limits are unsupported and strips it.
- `every …` belongs to `/loop`; toast and do not create.

Do not store goals in instruction entries. Do not implement this into V1/legacy, mini
TUI, or ACP.

### 5. Build/sync plumbing

- The canonical launcher and this context are versioned in `packages/cli/script/sync-and-build.sh`
  and `packages/cli/script/fork-context.md`. The installed launcher is a copy at
  `~/.local/libexec/opencode3-sync-and-build.sh`; keep that installed copy synchronized when editing it.
- Upstream active development moved to `dev` after the public V2 release. Verified on
  2026-10-21: upstream `dev` is 2.1.2; the old `v2` branch is 2.0.26 and last changed
  October 10. Our fork branch remains `v2-dev`; never confuse it with upstream's branch.
- `OPENCODE_CHANNEL=latest` so the build shares `opencode.db` with the installed OpenCode 2.
- Repair agent: `opencode-go/deepseek-v4.1-flash#max` (OpenCode Go, maximum effort).
  Both conflict resolution and build/test repair use the same explicit model reference.
  Keep standalone repair execution so an incompatible or rebuilding daemon does not block repairs.
- Use the existing OpenCode Go connection. Never print credentials or copy them into tracked files.

### 6. Raycast chat inside the existing oc3 daemon

Raycast Quick AI and AI Chat use our existing oc3 daemon, without a separate Python
process or LaunchAgent. This is intentional: do not restore the old Python bridge.

- `packages/server/src/raycast-chat.ts`: forwards the complete text message history to
  OpenCode Go, explicitly enables thinking and forces `reasoning_effort: max` for
  `deepseek-v4.1-flash`. Pass SSE bytes through immediately, including reasoning and `[DONE]`.
  Cancel upstream with request scope; keep the 180-second deadline and redacted upstream errors.
- `packages/protocol/src/groups/generate.ts`: `RaycastChatPath` and `RaycastChatInput`,
  POST `/api/raycast/v1/chat/completions`, model alias `oc3-deepseek-v4.1-flash-max`.
  Accept text and text-part arrays; reject tools, images, unrelated models, and empty histories.
- `packages/server/src/handlers/generate.ts`: resolve the active `opencode-go` integration
  credential from the daemon. Do not hardcode a cloud API key or create agent sessions/tools.
- `packages/server/src/auth.ts` + `middleware/authorization.ts`: Raycast bearer token is
  derived from the server password and accepted only on the exact POST chat route.
  Never accept it on administrative endpoints; rotation of the server password revokes it.
- Go requires conversation attribution. Raycast v1 supplies no conversation ID, so derive
  stable routing affinity from the first user message. Identical roots may share affinity;
  complete histories remain separate and must never be mixed or cached by this adapter.
- `packages/protocol/src/client.ts`: keep `generate.raycast` omitted from promise and Effect
  SDK adapters because it returns raw OpenAI JSON/SSE, not an ordinary typed SDK response.
- `packages/client/script/build.ts`: retain the `ConfigModel` type references. Without them,
  regenerated permission-config inputs lose model-ID brands and the pre-push typecheck fails.
- Tests (from `packages/server`):
  `bun test test/raycast-chat.test.ts test/auth.test.ts test/generate.test.ts`.
- Native Raycast config is `~/.config/raycast/ai/providers.yaml`, currently pointing at
  `http://127.0.0.1:49374/api/raycast/v1`. Do not overwrite its local auth token or model
  defaults while resolving a source conflict. Never record its contents in Git.


## Rules when you are fixing a rebase or a build

1. **Never drop a custom feature to make something compile.** Adapting our code to
   upstream's new interfaces is the job; deleting it is a regression. If our code calls an
   API upstream renamed or reshaped, port the call — don't remove the caller.
2. **Read `AGENTS.md` in the repo root** for upstream's own conventions and follow them.
3. Upstream renames hit us repeatedly. The most recent: `@opencode-ai/*` → `@opencode/*`
   (upstream `a5312e169b`). When a conflict is purely an import path, take upstream's path
   and keep our logic. Then grep the whole repo for other uses of the old form — files that
   never conflicted can still reference it.
4. **`bun run check` from the repo root is the gate.** The husky `pre-push` hook
   runs lint and workspace typechecks, including the generated clients. Per-package typechecks are not sufficient and have already let a failure
   through once.
5. A file byte-identical to upstream (`git diff upstream/dev...HEAD -- <file>` is empty)
   is not our breakage. Suspect environment or stale incremental state before rewriting
   upstream code. Known trap: `tsgo -b` state in `packages/*/node_modules/.ts-dist`
   survives `git clean -fd` (gitignored) and produces dozens of phantom errors against a
   newly rebased tree — deleting `.ts-dist` clears them. The script now purges this before
   calling you, so if you still see errors they are probably real.
6. **Commit your work.** Uncommitted changes are never pushed, and the next scheduled run
   opens with `git reset --hard origin/v2-dev`, which destroys them.
7. Do not run `git push`, `git reset --hard`, or `git rebase --abort` (unless the conflict
   is genuinely unresolvable). The script owns those.
