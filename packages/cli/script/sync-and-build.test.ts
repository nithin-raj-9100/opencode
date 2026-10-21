import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const source = new URL("./sync-and-build.sh", import.meta.url)
const context = new URL("./fork-context.md", import.meta.url)

test("repair launcher passes the Go max variant and current fork instructions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oc3-sync-test-"))
  try {
    const stub = path.join(dir, "agent")
    await writeFile(stub, '#!/bin/bash\nprintf "%s\\0" "$@" > "$CAPTURE"\n', { mode: 0o700 })
    const launcher = path.join(dir, "launcher.sh")
    await writeFile(launcher, (await readFile(source, "utf8")).replaceAll("/Users/nithin/.local/bin/opencode3", stub))
    const config = path.join(dir, "config.json")
    await writeFile(config, "{}")
    const capture = path.join(dir, "argv")
    const run = spawnSync("bash", ["-c", 'source "$LAUNCHER"\nREPO_DIR="$FIXTURE"\nAGENT_CONFIG="$CONFIG"\nFORK_CONTEXT="$CONTEXT"\nrun_agent "Resolve the fixture conflict"'], {
      env: { ...process.env, LAUNCHER: launcher, FIXTURE: dir, CONFIG: config, CONTEXT: Bun.fileURLToPath(context), CAPTURE: capture }, encoding: "utf8",
    })
    expect(run.status).toBe(0)
    const argv = (await readFile(capture, "utf8")).split("\0").filter(Boolean)
    expect(argv.slice(0, 5)).toEqual(["run", "--standalone", "--auto", "-m", "opencode-go/deepseek-v4.1-flash#max"])
    expect(argv[5]).toContain("Raycast chat inside the existing oc3 daemon")
    expect(argv[5]).toContain("Never restore the removed Python bridge")
    expect(argv[5]).toContain("Resolve the fixture conflict")
    expect(argv[5]).not.toContain("muse-spark")
    const missing = spawnSync("bash", ["-c", 'source "$LAUNCHER"\nREPO_DIR="$FIXTURE"\nAGENT_CONFIG="$CONFIG"\nFORK_CONTEXT="$FIXTURE/missing.md"\nrun_agent "fixture"'], {
      env: { ...process.env, LAUNCHER: launcher, FIXTURE: dir, CONFIG: config }, encoding: "utf8",
    })
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain("required fork context is missing")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("one-shot repair config grants the actual check commands and preserves provider settings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oc3-config-test-"))
  try {
    const base = path.join(dir, "base.json")
    await writeFile(base, JSON.stringify({ providers: { fixture: { name: "preserved" } }, permission_auto: { allow: ["existing"] } }))
    const launcher = path.join(dir, "launcher.sh")
    await writeFile(launcher, (await readFile(source, "utf8")).replace("/Users/nithin/.config/opencode/opencode.json", base))
    const output = path.join(dir, "config.json")
    const run = spawnSync("bash", ["-c", 'source "$LAUNCHER"\nSTATE_DIR="$FIXTURE"\nAGENT_CONFIG="$OUTPUT"\nwrite_agent_config'], {
      env: { ...process.env, LAUNCHER: launcher, FIXTURE: dir, OUTPUT: output }, encoding: "utf8",
    })
    expect(run.status).toBe(0)
    const config = JSON.parse(await readFile(output, "utf8"))
    expect(config.providers.fixture.name).toBe("preserved")
    expect(config.permission_auto.allow).toContain("$defaults")
    expect(config.permission_auto.allow).toContain("existing")
    expect(config.permissions).toContainEqual({ action: "shell", resource: "bun run check", effect: "allow" })
    expect(config.permissions).toContainEqual({ action: "shell", resource: "bun run generate", effect: "allow" })
    expect(JSON.parse(await readFile(base, "utf8")).permission_auto.allow).toEqual(["existing"])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("fork instructions survive a rebase conflict before their introducing commit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oc3-rebase-context-"))
  try {
    const run = spawnSync("bash", ["-c", `
set -euo pipefail
source "$LAUNCHER"
REPO_DIR="$FIXTURE/repo"
STATE_DIR="$FIXTURE/state"
mkdir -p "$REPO_DIR"
cd "$REPO_DIR"
git init -q -b base
git config user.email fixture@example.invalid
git config user.name Fixture
printf 'base\\n' > conflict.txt
git add conflict.txt
git commit -qm base
git checkout -qb fork
printf 'fork\\n' > conflict.txt
git commit -qam fork
printf 'Preserve fixture fork features\\n' > context.md
git add context.md
git commit -qm instructions
git checkout -q base
printf 'upstream\\n' > conflict.txt
git commit -qam upstream
git checkout -q fork
FORK_CONTEXT="$REPO_DIR/context.md"
snapshot_fork_context
if git rebase base > "$FIXTURE/rebase.log" 2>&1; then
  exit 2
fi
test ! -e "$REPO_DIR/context.md"
test -s "$FORK_CONTEXT"
test "$(stat -f %Lp "$FORK_CONTEXT")" = 600
fork_context
git rebase --abort
rm -f "$CONTEXT_SNAPSHOT"
`], {
      env: { ...process.env, LAUNCHER: Bun.fileURLToPath(source), FIXTURE: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8",
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain("Preserve fixture fork features")
  } finally { await rm(dir, { recursive: true, force: true }) }
})
