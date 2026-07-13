import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import LintPlugin, { detectLinter, lintFiles } from "../plugins/lint.js"

async function makeDir() {
  return mkdtemp(path.join(os.tmpdir(), "zaly-lint-plugin-"))
}

/** Puts a fake linter executable on PATH. */
async function withFakeLinter(name, script, run) {
  const dir = await makeDir()
  const executable = path.join(dir, name)
  await writeFile(executable, `#!/bin/sh\n${script}\n`)
  await chmod(executable, 0o755)

  const originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath ?? ""}`
  try {
    return await run()
  } finally {
    process.env.PATH = originalPath
  }
}

function fakeApi() {
  const handlers = new Map()
  const registered = new Map()
  const notifications = []
  return {
    api: {
      agent: { notify: (type, data) => notifications.push({ data, type }) },
      events: { on: (type, fn) => handlers.set(type, fn) },
      log: { debug() {} },
      tools: {
        async load([name]) {
          return [
            {
              name,
              desc: `${name} tool`,
              params: {},
              async call(args) {
                return args.result ?? { ok: true, path: args.path }
              },
            },
          ]
        },
        register: (def) => registered.set(def.name, def),
      },
    },
    handlers,
    notifications,
    registered,
  }
}

test("detectLinter finds a config in the same directory", async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, ".oxlintrc.json"), "{}")
  const detected = detectLinter(dir)
  assert.equal(detected?.linter.name, "oxlint")
  assert.equal(detected?.root, dir)
})

test("detectLinter walks up and prefers oxlint over eslint", async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, "oxlint.config.ts"), "")
  await writeFile(path.join(dir, "eslint.config.js"), "")
  const nested = path.join(dir, "src")
  await mkdir(nested)
  const detected = detectLinter(nested)
  assert.equal(detected?.linter.name, "oxlint")
  assert.equal(detected?.root, dir)
})

test("detectLinter returns null without a config", async () => {
  const dir = await makeDir()
  assert.equal(detectLinter(dir), null)
})

test("lintFiles reports output when the linter finds issues", { concurrency: false }, async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, ".oxlintrc.json"), "{}")
  const file = path.join(dir, "a.ts")
  await writeFile(file, "let x=1\n")
  const skipped = path.join(dir, "a.md")
  await writeFile(skipped, "")

  await withFakeLinter("oxlint", 'echo "1 warning found"; exit 1', async () => {
    const reports = lintFiles([file, skipped])
    assert.equal(reports.length, 1)
    assert.equal(reports[0].linter, "oxlint")
    assert.deepEqual(reports[0].files, [file])
    assert.match(reports[0].output, /1 warning found/)
  })
})

test("lintFiles runs golangci-lint only with its project config", { concurrency: false }, async () => {
  const dir = await makeDir()
  const file = path.join(dir, "main.go")
  await writeFile(file, "package main\n")
  assert.deepEqual(lintFiles([file]), [])

  await writeFile(path.join(dir, ".golangci.yml"), "linters: {}\n")
  await withFakeLinter("golangci-lint", 'echo "Go issue"; exit 1', async () => {
    const reports = lintFiles([file])
    assert.equal(reports[0]?.linter, "golangci-lint")
    assert.match(reports[0].output, /Go issue/)
  })
})

test("lintFiles runs Ruff only when configured", { concurrency: false }, async () => {
  const dir = await makeDir()
  const file = path.join(dir, "app.py")
  await writeFile(file, "x=1\n")
  await writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = \"demo\"\n")
  assert.deepEqual(lintFiles([file]), [])

  await writeFile(path.join(dir, "ruff.toml"), "line-length = 100\n")
  await withFakeLinter("ruff", 'echo "Python issue"; exit 1', async () => {
    const reports = lintFiles([file])
    assert.equal(reports[0]?.linter, "ruff")
    assert.match(reports[0].output, /Python issue/)
  })
})

test("lintFiles stays silent on a clean exit", { concurrency: false }, async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, ".oxlintrc.json"), "{}")
  const file = path.join(dir, "a.ts")
  await writeFile(file, "let x=1\n")

  await withFakeLinter("oxlint", 'echo "all clean"; exit 0', async () => {
    assert.deepEqual(lintFiles([file]), [])
  })
})

test("lintFiles ignores a missing linter binary", { concurrency: false }, async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, ".oxlintrc.json"), "{}")
  const file = path.join(dir, "a.ts")
  await writeFile(file, "let x=1\n")

  const originalPath = process.env.PATH
  process.env.PATH = ""
  try {
    assert.deepEqual(lintFiles([file]), [])
  } finally {
    process.env.PATH = originalPath
  }
})

test("plugin notifies the agent about lint issues on turn end", { concurrency: false }, async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, ".oxlintrc.json"), "{}")
  const file = path.join(dir, "a.ts")
  await writeFile(file, "let x=1\n")

  const { api, handlers, notifications, registered } = fakeApi()
  await LintPlugin(api)
  assert.deepEqual([...registered.keys()], ["edit", "write"])

  await registered.get("edit").call({ path: file }, {})
  await registered.get("edit").call({ path: file, result: { ok: false } }, {})

  await withFakeLinter("oxlint", 'echo "a.ts:1 unused variable"; exit 1', async () => {
    await handlers.get("agent:turn-end")()
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].type, "lint")
    assert.match(notifications[0].data, /oxlint reported issues/)
    assert.match(notifications[0].data, /unused variable/)

    // the pending set was drained: a second turn end does not re-notify
    await handlers.get("agent:turn-end")()
    assert.equal(notifications.length, 1)
  })
})

test("plugin stays silent when the lint passes", { concurrency: false }, async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, ".oxlintrc.json"), "{}")
  const file = path.join(dir, "a.ts")
  await writeFile(file, "let x=1\n")

  const { api, handlers, notifications, registered } = fakeApi()
  await LintPlugin(api)
  await registered.get("edit").call({ path: file }, {})

  await withFakeLinter("oxlint", "exit 0", async () => {
    await handlers.get("agent:turn-end")()
    assert.deepEqual(notifications, [])
  })
})
