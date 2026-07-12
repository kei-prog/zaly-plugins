import { spawnSync } from "node:child_process"

const REWRITE_TIMEOUT_MS = 2_000
const REWRITE_MAX_BUFFER = 1024 * 1024

export default async function RtkPlugin(api) {
  const [bash] = await api.tools.load(["bash"])
  if (!bash) throw new Error("The built-in bash tool is unavailable")

  api.tools.register({
    name: bash.name,
    desc: bash.desc,
    params: bash.params,
    parallel: bash.parallel,
    result: bash.result,
    preflight: bash.preflight,
    async call(args, ctx) {
      const command = rewrite(args.command)
      return bash.call({ ...args, command }, ctx)
    },
  })
}

export function rewrite(command) {
  const result = spawnSync("rtk", ["rewrite", command], {
    encoding: "utf8",
    maxBuffer: REWRITE_MAX_BUFFER,
    timeout: REWRITE_TIMEOUT_MS,
  })

  if (result.error || result.status !== 0) return command

  const rewritten = result.stdout.trim()
  return rewritten || command
}
