# ds-map — radar panel for DeepSeek Harness

A live radar of what the agent is doing, in its own window next to your terminal:
10 stations (`you`, `model`, `memory`, `files`, `shell`, `web`, `browser`,
`agents`, `skills`, `hooks`), the route between them, red error markers and a
real context ring.

![Panel in dark theme](https://raw.githubusercontent.com/Bbotirov/ds-map/main/docs/screenshots/panel-dark.png)

## What this extension does

It starts the harness **together with** the ds-map launcher inside VS Code's
integrated terminal, so one command brings up the sidecar, the harness and the
panel window, and `Ctrl-C` in that terminal takes all of it down.

| Command | What it does |
| --- | --- |
| `ds-map: Start panel with harness` | Opens a `ds-map` terminal and runs `node <cli> run -- <harness command>` |
| `ds-map: Stop panel (send Ctrl-C)` | Sends a real `Ctrl-C` (0x03) into that terminal, then closes it if it survived |
| `ds-map: Run diagnostics` | Runs `dsmap doctor` and shows the output in the ds-map log channel |

A status-bar item shows whether the panel is up and links to the diagnostics.

## Requirements

ds-map itself must be built (`pnpm install && pnpm build`) — the extension only
launches it. It looks for `dist/cli.js` in this order:

1. `dsMap.cliPath` setting (supports `${workspaceFolder}`, `${userHome}`, `~`)
2. `DSMAP_BIN` environment variable
3. `dist/cli.js` of the open workspace folder
4. `ds-map` installed globally via npm/pnpm

If nothing is found, the extension tells you instead of guessing.

Put both settings in **User** scope to get the commands in every window; a
relative `dsMap.cliPath` (e.g. `${workspaceFolder}/dist/cli.js`) only resolves
while the ds-map project itself is open. `dsMap.harnessCommand` should use a
session profile such as `dsh --profile web` — with `--profile headless` the
harness finishes one turn and exits, and the panel closes with it by design.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `dsMap.cliPath` | `""` | Explicit path to `dist/cli.js` |
| `dsMap.harnessCommand` | `dsh` | Command after `dsmap run --`, e.g. `dsh --profile web` |

## Privacy

- The panel reads **event names only** — never prompt text, file contents,
  command lines or tool results. The feed shows labels derived from names.
- No network calls: no telemetry, no update checks, no CDN fonts.
- The sidecar listens on `127.0.0.1` with a random port and a token that is
  checked on every request; the token file is written with `600` permissions.
- Nothing is kept between sessions; debug logs carry event names and timings.
- This extension ships no bundled runtime: it only spawns the local CLI.

## Uninstall / stop

`Ctrl-C` in the `ds-map` terminal (or the Stop command) shuts the launcher,
the panel window and the sidecar down. No orphan processes are left behind.

## License

MIT. Station icon geometry and colour tokens are adapted from
[lot-map](https://github.com/alexeyw/lot-map) (MIT, Aleksei Volodin).
