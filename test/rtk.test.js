import assert from "node:assert/strict"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { rewrite } from "../plugins/rtk.js"

async function withFakeRtk(script, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zaly-rtk-plugin-"))
  const executable = path.join(dir, "rtk")
  await writeFile(executable, `#!/bin/sh\n${script}\n`)
  await chmod(executable, 0o755)

  const originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath ?? ""}`
  try {
    return run()
  } finally {
    process.env.PATH = originalPath
  }
}

test("returns a successful rtk rewrite", { concurrency: false }, async () => {
  await withFakeRtk('printf \'rewritten:%s\\n\' "$2"', () => {
    assert.equal(rewrite("git status"), "rewritten:git status")
  })
})

test("keeps the original command when rtk exits non-zero", { concurrency: false }, async () => {
  await withFakeRtk("printf 'partial output\\n'; exit 1", () => {
    assert.equal(rewrite("git status"), "git status")
  })
})

test("keeps the original command when rtk is unavailable", { concurrency: false }, () => {
  const originalPath = process.env.PATH
  process.env.PATH = ""
  try {
    assert.equal(rewrite("git status"), "git status")
  } finally {
    process.env.PATH = originalPath
  }
})
