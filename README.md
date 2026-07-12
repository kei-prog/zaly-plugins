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

## License

MIT
