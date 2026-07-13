import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const LINT_TIMEOUT_MS = 60_000
const LINT_MAX_BUFFER = 4 * 1024 * 1024
const REPORT_MAX_CHARS = 4_000

// One entry per linter, checked in order at every directory level.
// Add a row to support another linter.
const WEB_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"])
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"])
const GO_EXTENSIONS = new Set([".go"])

const LINTERS = [
  {
    name: "golangci-lint",
    extensions: GO_EXTENSIONS,
    configs: [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"],
    command: (files) => ["golangci-lint", ["run", ...files]],
  },
  {
    name: "ruff",
    extensions: PYTHON_EXTENSIONS,
    detect: hasRuffConfig,
    command: (files) => ["ruff", ["check", ...files]],
  },
  {
    name: "oxlint",
    extensions: WEB_EXTENSIONS,
    configs: [".oxlintrc.json", "oxlint.config.ts", "oxlint.config.js", "oxlint.config.mjs"],
    command: (files) => ["oxlint", [...files]],
  },
  {
    name: "biome",
    extensions: WEB_EXTENSIONS,
    configs: ["biome.json", "biome.jsonc"],
    command: (files) => ["biome", ["lint", ...files]],
  },
  {
    name: "eslint",
    extensions: WEB_EXTENSIONS,
    configs: [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      "eslint.config.ts",
      ".eslintrc",
      ".eslintrc.json",
      ".eslintrc.cjs",
    ],
    command: (files) => ["eslint", [...files]],
  },
]

const EXTENSIONS = new Set(LINTERS.flatMap(({ extensions }) => [...extensions]))

export default async function LintPlugin(api) {
  const pending = new Set()

  for (const name of ["edit", "write"]) {
    const [tool] = await api.tools.load([name])
    if (!tool) throw new Error(`The built-in ${name} tool is unavailable`)

    api.tools.register({
      name: tool.name,
      desc: tool.desc,
      params: tool.params,
      parallel: tool.parallel,
      result: tool.result,
      preflight: tool.preflight,
      async call(args, ctx) {
        const result = await tool.call(args, ctx)
        if (result?.ok && result.path) pending.add(result.path)
        return result
      },
    })
  }

  const cache = new Map()
  let running = false
  api.events.on("agent:turn-end", () => {
    if (running || pending.size === 0) return
    running = true
    const files = [...pending]
    pending.clear()
    try {
      for (const report of lintFiles(files, cache)) {
        api.log.debug(`${report.linter} reported issues in ${report.files.length} file(s)`)
        api.agent.notify(
          "lint",
          `${report.linter} reported issues in files modified last turn:\n\n${report.output}`
        )
      }
    } finally {
      running = false
    }
  })
}

/** Walk up from `dir` looking for a linter config. Returns
 *  `{ linter, root }` or null. Results are memoized per directory. */
export function detectLinter(dir, cache, extension) {
  const cacheKey = extension ? `${dir}\0${extension}` : dir
  if (cache?.has(cacheKey)) return cache.get(cacheKey)

  let result = null
  for (const linter of LINTERS) {
    if (!linter.extensions.has(extension ?? ".js")) continue
    const detected = linter.detect?.(dir) ?? linter.configs.some((config) => existsSync(path.join(dir, config)))
    if (detected) {
      result = { linter, root: dir }
      break
    }
  }
  if (!result) {
    const parent = path.dirname(dir)
    if (parent !== dir) result = detectLinter(parent, cache, extension)
  }

  cache?.set(cacheKey, result)
  return result
}

/** Lint `files` (absolute paths), grouped per detected linter root.
 *  Missing files, unsupported extensions, and missing linters are skipped
 *  silently. Returns a report per group that exited with issues. */
export function lintFiles(files, cache) {
  const groups = new Map()
  for (const file of files) {
    if (!EXTENSIONS.has(path.extname(file))) continue
    if (!existsSync(file)) continue
    const detected = detectLinter(path.dirname(file), cache, path.extname(file))
    if (!detected) continue
    const key = `${detected.linter.name}\0${detected.root}`
    const group = groups.get(key) ?? { ...detected, files: [] }
    group.files.push(file)
    groups.set(key, group)
  }

  const reports = []
  for (const { linter, root, files: groupFiles } of groups.values()) {
    const [command, args] = linter.command(groupFiles)
    const result = spawnSync(resolveBin(root, command), args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: LINT_MAX_BUFFER,
      timeout: LINT_TIMEOUT_MS,
    })
    if (result.error || result.status === 0) continue
    const output = truncate(`${result.stdout ?? ""}${result.stderr ?? ""}`.trim())
    if (!output) continue
    reports.push({ files: groupFiles, linter: linter.name, output, root })
  }
  return reports
}

/** Prefer the linter installed in the project's node_modules/.bin. */
function resolveBin(root, command) {
  for (const directory of [path.join("node_modules", ".bin"), path.join(".venv", "bin")]) {
    const local = path.join(root, directory, command)
    if (existsSync(local)) return local
  }
  return command
}

function hasRuffConfig(dir) {
  if (["ruff.toml", ".ruff.toml"].some((config) => existsSync(path.join(dir, config)))) return true
  const pyproject = path.join(dir, "pyproject.toml")
  if (!existsSync(pyproject)) return false
  try {
    return /(?:^|\n)\s*\[tool\.ruff(?:\.|\])/.test(readFileSync(pyproject, "utf8"))
  } catch {
    return false
  }
}

function truncate(text) {
  if (text.length <= REPORT_MAX_CHARS) return text
  return `${text.slice(0, REPORT_MAX_CHARS)}\n… (truncated)`
}
