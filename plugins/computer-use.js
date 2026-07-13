import { randomUUID } from "node:crypto"

import { createJiti } from "jiti"

const COMPUTER_USE_META = "piComputerUse"
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"])

/**
 * Expose pi-computer-use through zaly's plugin API.
 *
 * The upstream extension remains responsible for schemas, immutable UI state,
 * accessibility backends, action verification, and native-helper setup. This
 * adapter only translates the host API and result format.
 */
export default createComputerUsePlugin()

export function createComputerUsePlugin(options = {}) {
  const loadExtension = options.loadExtension ?? loadPiComputerUseExtension

  return async function ComputerUsePlugin(api) {
    const lifecycle = new Map()
    const registeredTools = new Set()
    const piContext = createPiContext(api)

    const extension = await loadExtension()
    extension({
      on(event, handler) {
        const handlers = lifecycle.get(event) ?? []
        handlers.push(handler)
        lifecycle.set(event, handlers)
      },
      registerCommand(name, command) {
        api.ui.registerActions({
          id: `computer-use.${name}`,
          cmd: name,
          desc: command.description,
          keys: [],
          fn: () => command.handler("", piContext),
        })
      },
      registerTool(tool) {
        registerTool(api, tool, piContext)
        registeredTools.add(tool.name)
      },
    })

    api.tools.active = [...new Set([...api.tools.active, ...registeredTools])]

    const runLifecycle = async (event) => {
      for (const handler of lifecycle.get(event) ?? []) await handler({}, piContext)
    }

    await runLifecycle("session_start")

    api.events.on("session", async () => {
      await runLifecycle("session_shutdown")
      await runLifecycle("session_start")
    })

    api.signal.addEventListener(
      "abort",
      () => {
        api.tools.active = api.tools.active.filter((name) => !registeredTools.has(name))
        void runLifecycle("session_shutdown")
      },
      { once: true }
    )
  }
}

export async function loadPiComputerUseExtension() {
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false })
  return await jiti.import("@injaneity/pi-computer-use/extensions/computer-use.ts", {
    default: true,
  })
}

export function registerTool(api, tool, piContext = createPiContext(api)) {
  if (!tool?.name || !tool.parameters || typeof tool.execute !== "function") {
    throw new Error("pi-computer-use registered an unsupported tool definition")
  }

  api.tools.register({
    name: tool.name,
    desc: toolDescription(tool),
    params: tool.parameters,
    async call(args, ctx) {
      const result = await tool.execute(randomUUID(), args, ctx.signal, undefined, piContext)
      if (result?.details !== undefined) {
        ctx.meta ??= {}
        ctx.meta[COMPUTER_USE_META] = { details: result.details, version: 1 }
      }
      return convertPiContent(result?.content)
    },
  })
}

export function createPiContext(api) {
  return {
    get cwd() {
      return api.agent.cwd ?? process.cwd()
    },
    hasUI: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    sessionManager: {
      getBranch() {
        return toPiBranch(api.agent.messages)
      },
    },
    ui: {
      notify(message, level = "info") {
        api.ui.notify(String(message), { level: notificationLevel(level) })
      },
      async select(prompt, options) {
        const selected = await api.ui.pick({
          items: options.map((text) => ({ text })),
          title: prompt,
        })
        return selected?.text
      },
    },
  }
}

export function convertPiContent(content) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : ""

  return content.map((part) => {
    if (part?.type === "text") return { text: String(part.text ?? ""), type: "text" }
    if (part?.type === "image" && typeof part.data === "string") {
      const mime = IMAGE_MIMES.has(part.mimeType) ? part.mimeType : "image/jpeg"
      return {
        mime,
        source: { data: part.data, type: "base64" },
        type: "image",
      }
    }
    return { text: JSON.stringify(part ?? null), type: "text" }
  })
}

export function toPiBranch(messages) {
  const branch = []
  for (const message of messages ?? []) {
    if (message?.role !== "tool" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const details = part?.meta?.[COMPUTER_USE_META]?.details
      if (part?.type !== "tool-result" || details === undefined) continue
      branch.push({
        type: "message",
        message: {
          role: "toolResult",
          toolName: part.name,
          details,
        },
      })
    }
  }
  return branch
}

function toolDescription(tool) {
  return [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])]
    .filter(Boolean)
    .join("\n")
}

function notificationLevel(level) {
  if (level === "warning") return "warn"
  if (["error", "info", "success", "warn"].includes(level)) return level
  return "info"
}
