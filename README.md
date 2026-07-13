# zaly-plugins

Personal plugins for [zaly](https://github.com/folke/zaly).

## RTK bash rewriter

`plugins/rtk.js` wraps zaly's built-in `bash` tool and passes each command through [`rtk rewrite`](https://github.com/rtk-ai/rtk) before execution. If RTK is unavailable, times out, exits unsuccessfully, or returns empty output, the original command is preserved.

### Requirements

- zaly
- Node.js 22.11 or newer
- `rtk` available on `PATH`

### Install

Clone the repository and link the plugin into zaly's user resource directory:

```bash
git clone git@github.com:kei-prog/zaly-plugins.git
mkdir -p ~/.config/zaly/plugins
ln -sfn "$PWD/zaly-plugins/plugins/rtk.js" ~/.config/zaly/plugins/rtk.js
```

If the repository is managed with `ghq`:

```bash
ghq get git@github.com:kei-prog/zaly-plugins.git
ln -sfn "$(ghq root)/github.com/kei-prog/zaly-plugins/plugins/rtk.js" \
  ~/.config/zaly/plugins/rtk.js
```

Restart zaly or run `/reload` after changing plugins.

### Verify

```bash
npm test
zaly --print-config
```

The resolved resources should include `~/.config/zaly/plugins/rtk.js`.

## Format on turn end

`plugins/format.js` wraps zaly's built-in `edit` and `write` tools to record
which files the agent modified, then formats them in one batch when the turn
ends (`agent:turn-end`).

The formatter is auto-detected by walking up from each file's directory:

| File/config                                      | Formatter              |
| ------------------------------------------------ | ---------------------- |
| `.go`                                            | `gofmt -w`             |
| `.py`, `.pyi` with Ruff configuration            | `ruff format`          |
| `biome.json`, `biome.jsonc`                      | `biome format --write` |
| `.oxfmtrc.json`                                  | `oxfmt`                |
| `.prettierrc*`, `prettier.config.*`              | `prettier --write`     |

Ruff is enabled by `ruff.toml`, `.ruff.toml`, or a `[tool.ruff]` table in
`pyproject.toml`. Project-local binaries (`node_modules/.bin` and `.venv/bin`)
are preferred over `PATH`. Unsupported files and missing or failing formatters
are skipped silently. Files written via the `bash` tool are not tracked.

### Install

```bash
ln -sfn "$(ghq root)/github.com/kei-prog/zaly-plugins/plugins/format.js" \
  ~/.config/zaly/plugins/format.js
```

Restart zaly or run `/reload` after changing plugins.

## Lint feedback on turn end

`plugins/lint.js` wraps zaly's built-in `edit` and `write` tools to record
which files the agent modified, lints them when the turn ends, and — only when
issues are found — queues the linter output as a system notification the model
sees at the start of its next turn (`api.agent.notify`).

The linter is auto-detected by walking up from each file's directory:

| File/config                                      | Linter                |
| ------------------------------------------------ | --------------------- |
| `.go` with `.golangci.{yml,yaml,toml,json}`      | `golangci-lint run`   |
| `.py`, `.pyi` with Ruff configuration            | `ruff check`          |
| `.oxlintrc.json`, `oxlint.config.*`              | `oxlint`              |
| `biome.json`, `biome.jsonc`                      | `biome lint`          |
| `eslint.config.*`, `.eslintrc*`                  | `eslint`              |

Only linters explicitly configured by the project are run. Project-local
binaries (`node_modules/.bin` and `.venv/bin`) are preferred over `PATH`.
Output is truncated to 4000 characters, and a missing or crashing linter is
skipped silently. Files written via the `bash` tool are not tracked.

### Install

```bash
ln -sfn "$(ghq root)/github.com/kei-prog/zaly-plugins/plugins/lint.js" \
  ~/.config/zaly/plugins/lint.js
```

Restart zaly or run `/reload` after changing plugins.

## License

MIT
