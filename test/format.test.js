import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import FormatPlugin, { detectFormatter, formatFiles } from "../plugins/format.js"

async function makeDir() {
  return mkdtemp(path.join(os.tmpdir(), "zaly-format-plugin-"))
}

/** Puts a fake formatter executable on PATH that appends its arguments to
 *  `logFile`, one per line. */
async function withFakeFormatter(name, logFile, run) {
  const dir = await makeDir()
  const executable = path.join(dir, name)
  await writeFile(executable, `#!/bin/sh\nfor arg in "$@"; do echo "$arg" >> "${logFile}"; done\n`)
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
  return {
    api: {
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
    registered,
  }
}

test("detectFormatter finds a config in the same directory", async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, "biome.json"), "{}")
  const detected = detectFormatter(dir)
  assert.equal(detected?.formatter.name, "biome")
  assert.equal(detected?.root, dir)
})

test("detectFormatter walks up to a parent config", async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, ".prettierrc"), "{}")
  const nested = path.join(dir, "src", "deep")
  await mkdir(nested, { recursive: true })
  const detected = detectFormatter(nested)
  assert.equal(detected?.formatter.name, "prettier")
  assert.equal(detected?.root, dir)
})

test("detectFormatter prefers biome over prettier in the same directory", async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, "biome.json"), "{}")
  await writeFile(path.join(dir, ".prettierrc"), "{}")
  assert.equal(detectFormatter(dir)?.formatter.name, "biome")
})

test("detectFormatter returns null without a config", async () => {
  const dir = await makeDir()
  assert.equal(detectFormatter(dir), null)
})

test("detectFormatter uses the cache", async () => {
  const dir = await makeDir()
  const sentinel = { formatter: { configs: [], name: "stub" }, root: dir }
  const cache = new Map([[dir, sentinel]])
  assert.equal(detectFormatter(dir, cache), sentinel)
})

test("formatFiles runs the detected formatter on supported files", { concurrency: false }, async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, ".oxfmtrc.json"), "{}")
  const file = path.join(dir, "a.ts")
  await writeFile(file, "let x=1\n")
  const skippedExt = path.join(dir, "a.lock")
  await writeFile(skippedExt, "")
  const missing = path.join(dir, "gone.ts")

  const logFile = path.join(dir, "calls.log")
  await withFakeFormatter("oxfmt", logFile, async () => {
    const runs = formatFiles([file, skippedExt, missing])
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0].files, [file])
    assert.equal(runs[0].formatter, "oxfmt")
  })
})

test("formatFiles runs gofmt for Go files without a config", { concurrency: false }, async () => {
  const dir = await makeDir()
  const file = path.join(dir, "main.go")
  await writeFile(file, "package main\n")
  const logFile = path.join(dir, "gofmt.log")

  await withFakeFormatter("gofmt", logFile, async () => {
    const runs = formatFiles([file])
    assert.equal(runs[0]?.formatter, "gofmt")
    const { readFile } = await import("node:fs/promises")
    assert.deepEqual((await readFile(logFile, "utf8")).trim().split("\n"), ["-w", file])
  })
})

test("formatFiles runs Ruff only when the project config enables it", { concurrency: false }, async () => {
  const dir = await makeDir()
  const file = path.join(dir, "app.py")
  await writeFile(file, "x=1\n")
  await writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = \"demo\"\n")
  assert.deepEqual(formatFiles([file]), [])

  await writeFile(path.join(dir, "pyproject.toml"), "[tool.ruff]\nline-length = 100\n")
  const logFile = path.join(dir, "ruff.log")
  await withFakeFormatter("ruff", logFile, async () => {
    const runs = formatFiles([file])
    assert.equal(runs[0]?.formatter, "ruff")
    const { readFile } = await import("node:fs/promises")
    assert.deepEqual((await readFile(logFile, "utf8")).trim().split("\n"), ["format", file])
  })
})

test("formatFiles ignores a missing formatter binary", { concurrency: false }, async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, "biome.json"), "{}")
  const file = path.join(dir, "a.ts")
  await writeFile(file, "let x=1\n")

  const originalPath = process.env.PATH
  process.env.PATH = ""
  try {
    assert.deepEqual(formatFiles([file]), [])
  } finally {
    process.env.PATH = originalPath
  }
})

test("formatFiles prefers the project-local binary", { concurrency: false }, async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, "biome.json"), "{}")
  const file = path.join(dir, "a.ts")
  await writeFile(file, "let x=1\n")

  const logFile = path.join(dir, "local-calls.log")
  const bin = path.join(dir, "node_modules", ".bin")
  await mkdir(bin, { recursive: true })
  const local = path.join(bin, "biome")
  await writeFile(local, `#!/bin/sh\necho "local" >> "${logFile}"\n`)
  await chmod(local, 0o755)

  const runs = formatFiles([file])
  assert.equal(runs.length, 1)
  const { readFile } = await import("node:fs/promises")
  assert.equal(await readFile(logFile, "utf8"), "local\n")
})

test("plugin records edited files and formats them on turn end", { concurrency: false }, async () => {
  const dir = await makeDir()
  await writeFile(path.join(dir, "biome.json"), "{}")
  const file = path.join(dir, "a.ts")
  await writeFile(file, "let x=1\n")

  const { api, handlers, registered } = fakeApi()
  await FormatPlugin(api)
  assert.deepEqual([...registered.keys()], ["edit", "write"])

  const edit = registered.get("edit")
  await edit.call({ path: file }, {})
  await edit.call({ path: file, result: { ok: false } }, {}) // failures are not recorded
  await edit.call({ path: path.join(dir, "missing.ts") }, {}) // deleted before turn end

  const logFile = path.join(dir, "calls.log")
  await withFakeFormatter("biome", logFile, async () => {
    await handlers.get("agent:turn-end")()
    const { readFile } = await import("node:fs/promises")
    const calls = (await readFile(logFile, "utf8")).trim().split("\n")
    assert.deepEqual(calls, ["format", "--write", file])

    // the pending set was drained: a second turn end does nothing
    await handlers.get("agent:turn-end")()
    assert.equal((await readFile(logFile, "utf8")).trim().split("\n").length, 3)
  })
})

test("plugin turn end does not throw when no formatter exists", async () => {
  const dir = await makeDir()
  const file = path.join(dir, "a.ts")
  await writeFile(file, "let x=1\n")

  const { api, handlers, registered } = fakeApi()
  await FormatPlugin(api)
  await registered.get("edit").call({ path: file }, {})
  await handlers.get("agent:turn-end")()
})
