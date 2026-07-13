import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const FORMAT_TIMEOUT_MS = 30_000
const FORMAT_MAX_BUFFER = 1024 * 1024

// One entry per formatter, checked in order at every directory level.
// Add a row to support another formatter.
const WEB_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
  ".css",
  ".md",
])
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"])
const GO_EXTENSIONS = new Set([".go"])

const FORMATTERS = [
  {
    name: "gofmt",
    extensions: GO_EXTENSIONS,
    detect: () => true,
    command: (files) => ["gofmt", ["-w", ...files]],
  },
  {
    name: "ruff",
    extensions: PYTHON_EXTENSIONS,
    detect: hasRuffConfig,
    command: (files) => ["ruff", ["format", ...files]],
  },
  {
    name: "biome",
    extensions: WEB_EXTENSIONS,
    configs: ["biome.json", "biome.jsonc"],
    command: (files) => ["biome", ["format", "--write", ...files]],
  },
  {
    name: "oxfmt",
    extensions: WEB_EXTENSIONS,
    configs: [".oxfmtrc.json"],
    command: (files) => ["oxfmt", [...files]],
  },
  {
    name: "prettier",
    extensions: WEB_EXTENSIONS,
    configs: [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.yaml",
      ".prettierrc.yml",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.mjs",
      ".prettierrc.toml",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
    ],
    command: (files) => ["prettier", ["--write", ...files]],
  },
]

const EXTENSIONS = new Set(FORMATTERS.flatMap(({ extensions }) => [...extensions]))

export default async function FormatPlugin(api) {
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
      const runs = formatFiles(files, cache)
      for (const run of runs) {
        api.log.debug(`formatted ${run.files.length} file(s) with ${run.formatter}`)
      }
    } finally {
      running = false
    }
  })
}

/** Walk up from `dir` looking for a formatter config. Returns
 *  `{ formatter, root }` or null. Results are memoized per directory. */
export function detectFormatter(dir, cache, extension) {
  const cacheKey = extension ? `${dir}\0${extension}` : dir
  if (cache?.has(cacheKey)) return cache.get(cacheKey)

  let result = null
  for (const formatter of FORMATTERS) {
    if (!formatter.extensions.has(extension ?? ".js")) continue
    const detected = formatter.detect?.(dir) ?? formatter.configs.some((config) => existsSync(path.join(dir, config)))
    if (detected) {
      result = { formatter, root: dir }
      break
    }
  }
  if (!result) {
    const parent = path.dirname(dir)
    if (parent !== dir) result = detectFormatter(parent, cache, extension)
  }

  cache?.set(cacheKey, result)
  return result
}

/** Format `files` (absolute paths), grouped per detected formatter root.
 *  Missing files, unsupported extensions, and formatter failures are
 *  skipped silently. Returns the runs that succeeded. */
export function formatFiles(files, cache) {
  const groups = new Map()
  for (const file of files) {
    if (!EXTENSIONS.has(path.extname(file))) continue
    if (!existsSync(file)) continue
    const detected = detectFormatter(path.dirname(file), cache, path.extname(file))
    if (!detected) continue
    const key = `${detected.formatter.name}\0${detected.root}`
    const group = groups.get(key) ?? { ...detected, files: [] }
    group.files.push(file)
    groups.set(key, group)
  }

  const runs = []
  for (const { formatter, root, files: groupFiles } of groups.values()) {
    const [command, args] = formatter.command(groupFiles)
    const result = spawnSync(resolveBin(root, command), args, {
      cwd: root,
      maxBuffer: FORMAT_MAX_BUFFER,
      stdio: "ignore",
      timeout: FORMAT_TIMEOUT_MS,
    })
    if (result.error || result.status !== 0) continue
    runs.push({ files: groupFiles, formatter: formatter.name, root })
  }
  return runs
}

/** Prefer the formatter installed in the project's node_modules/.bin. */
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
