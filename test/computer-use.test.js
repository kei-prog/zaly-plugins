import assert from "node:assert/strict"
import test from "node:test"

import {
  convertPiContent,
  createComputerUsePlugin,
  registerTool,
  toPiBranch,
} from "../plugins/computer-use.js"

test("converts Pi text and image results to zaly content parts", () => {
  assert.deepEqual(
    convertPiContent([
      { type: "text", text: "State state-1" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
    ]),
    [
      { type: "text", text: "State state-1" },
      {
        type: "image",
        mime: "image/jpeg",
        source: { type: "base64", data: "aGVsbG8=" },
      },
    ]
  )
})

test("reconstructs Pi tool history from zaly result metadata", () => {
  assert.deepEqual(
    toPiBranch([
      { role: "user", content: "inspect the app" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            name: "observe_ui",
            meta: { piComputerUse: { version: 1, details: { tool: "observe_ui", stateId: "s1" } } },
          },
          { type: "tool-result", name: "read", meta: {} },
        ],
      },
    ]),
    [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "observe_ui",
          details: { tool: "observe_ui", stateId: "s1" },
        },
      },
    ]
  )
})

test("registers an executable zaly tool and preserves Pi state metadata", async () => {
  let definition
  const api = {
    tools: {
      register(tool) {
        definition = tool
      },
    },
  }
  const piContext = { cwd: "/tmp" }

  registerTool(
    api,
    {
      name: "observe_ui",
      description: "Observe",
      promptSnippet: "Use refs.",
      promptGuidelines: ["Refresh stale state."],
      parameters: { type: "object", properties: {} },
      async execute(_id, params, signal, _update, context) {
        assert.deepEqual(params, { root: "@r1" })
        assert.equal(context, piContext)
        assert.ok(signal instanceof AbortSignal)
        return {
          content: [{ type: "text", text: "observed" }],
          details: { tool: "observe_ui", stateId: "s1" },
        }
      },
    },
    piContext
  )

  assert.equal(definition.desc, "Observe\nUse refs.\nRefresh stale state.")
  const meta = {}
  const result = await definition.call(
    { root: "@r1" },
    { meta, signal: new AbortController().signal }
  )
  assert.deepEqual(result, [{ type: "text", text: "observed" }])
  assert.deepEqual(meta.piComputerUse, {
    version: 1,
    details: { tool: "observe_ui", stateId: "s1" },
  })
})

test("maps Pi tools, commands, and session lifecycle onto zaly", async () => {
  const calls = []
  const registered = []
  const actions = []
  let sessionHandler
  const abort = new AbortController()
  const api = {
    agent: { cwd: "/workspace", messages: [] },
    events: {
      on(event, handler) {
        if (event === "session") sessionHandler = handler
      },
    },
    signal: abort.signal,
    tools: {
      active: ["read"],
      register(tool) {
        registered.push(tool.name)
      },
    },
    ui: {
      notify() {},
      pick: async () => undefined,
      registerActions(action) {
        actions.push(action)
      },
    },
  }

  const plugin = createComputerUsePlugin({
    loadExtension: async () => (pi) => {
      pi.registerTool({
        name: "find_roots",
        description: "Find roots",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [] }),
      })
      pi.registerCommand("computer-use", {
        description: "Show config",
        handler: () => calls.push("command"),
      })
      pi.on("session_start", () => calls.push("start"))
      pi.on("session_shutdown", () => calls.push("shutdown"))
    },
  })

  await plugin(api)
  assert.deepEqual(registered, ["find_roots"])
  assert.deepEqual(api.tools.active, ["read", "find_roots"])
  assert.equal(actions[0].cmd, "computer-use")
  await actions[0].fn()
  assert.deepEqual(calls, ["start", "command"])

  await sessionHandler()
  assert.deepEqual(calls, ["start", "command", "shutdown", "start"])

  abort.abort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(api.tools.active, ["read"])
  assert.deepEqual(calls, ["start", "command", "shutdown", "start", "shutdown"])
})

test("loads the pinned upstream pi-computer-use extension", async () => {
  const registered = []
  const actions = []
  const abort = new AbortController()
  const api = {
    agent: { cwd: "/workspace", messages: [] },
    events: { on() {} },
    signal: abort.signal,
    tools: {
      active: [],
      register(tool) {
        registered.push(tool.name)
      },
    },
    ui: {
      notify() {},
      pick: async () => undefined,
      registerActions(action) {
        actions.push(action)
      },
    },
  }

  await createComputerUsePlugin()(api)

  assert.deepEqual(registered, [
    "find_roots",
    "observe_ui",
    "search_ui",
    "expand_ui",
    "inspect_ui",
    "act_ui",
    "read_text",
    "wait_for",
    "launch_browser",
    "navigate_browser",
    "evaluate_browser",
  ])
  assert.deepEqual(api.tools.active, registered)
  assert.equal(actions[0].cmd, "computer-use")

  abort.abort()
  await new Promise((resolve) => setImmediate(resolve))
})
