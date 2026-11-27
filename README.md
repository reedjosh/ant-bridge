# ant-bridge

Use Antigravity (`agy`) models inside Pi while keeping your Pi extensions, MCP servers, subagents, and skills working.

`ant-bridge` runs `agy acp` as a Pi model provider under `antigravity`. It exposes your Pi tools to `agy` over a local
`127.0.0.1` HTTP bridge without adding extra Pi tools, wrapping built-in file or shell tools, or editing global MCP
config files.

## Requirements

- Pi 1.5 or newer (`pi --version`).
- `agy` 1.5.3 or newer on `PATH` and signed in (`agy --version`, or run `agy` once to sign in).

## Install

```sh
pi install git:github.com/reedjosh/ant-bridge
```

To update later:

```sh
pi update git:github.com/reedjosh/ant-bridge
```

## Quick start

Switch to an Antigravity model inside Pi:

```text
/model antigravity/gemini-4-carbon
```

Or make it your default in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "antigravity",
  "defaultModel": "gemini-4-carbon"
}
```

## How it works

`agy` handles file reads, edits, search, and shell commands in its own runtime. `ant-bridge` skips Pi's core file and
shell tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) so nothing is duplicated.

Everything else in Pi bridges over a per-session `127.0.0.1` HTTP server secured with a random `x-bridge-token` header:

- Pi extensions (`codemode`, `mcp`, `tool-search`, `pi-subagents`, and others) run on the `pi-bridge` route.
- Direct Pi MCP servers run on separate `pi-bridge-<server>` routes so tool calls show up cleanly as `<server>/<tool>`.
- Pi Agent Skills load live through `activate_skill` from `pi.getCommands()`, with a filesystem fallback.

If your active tool list changes between turns (from `tool_search`, `/mcp`, `/agy bridge`, `/agy tools`, or `/reload`),
`ant-bridge` restarts `agy acp` and reloads the same session so `agy` picks up the new tools without losing history.

Long-running bridged calls do not hit transport timeouts. If a call runs past its foreground window (120s for
`subagent` and `codemode`, 20s for other tools), the bridge returns a `STILL RUNNING` handle and `agy` polls
`bridge_poll_result` until it finishes.

Streaming turns show live token counts in the Pi status bar (`ACP <in> in (+<cached> cached) / <out> out` when native
usage is reported, or `ACP ~ <in> in / <out> out` for estimates).

Each `agy acp` process uses a staged `HOME` under `<agentDir>/antigravity-bridge/acp-home/` with its `antigravity-cli`
directory symlinked to `~/.gemini/antigravity-cli`. That keeps MCP config isolated while preserving conversation state
across restarts.

## MCP server exposure

Pi 1.5 controls how MCP servers in `~/.pi/agent/mcp.json`, `.pi/mcp.json`, or `/mcp` are exposed to the model:

- `"exposure": "direct"` (recommended for servers you use often): Pi declares each tool directly, and `ant-bridge`
  serves it on `pi-bridge-<server>`. You can also promote specific tools on a large server with `"toolExposure"`.
- `"exposure": "codemode"` (Pi default): `agy` calls tools through `codemode` (`searchTools`, `describeNamespace`,
  `tools.mcp__<server>__<tool>`) to batch or filter work in one script.
- `"exposure": "deferred"`: Tools stay hidden until `tool_search` loads them. On the next turn, `ant-bridge` reloads
  `agy acp` with the newly loaded tools on `pi-bridge-<server>`.

```json
{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "exposure": "direct"
    }
  }
}
```

## Commands

Run `/agy` in Pi to open the settings picker (or print status in non-TUI mode), or use a subcommand:

| Command | What it does |
| --- | --- |
| `/agy` | Open settings (`bridgeTools`, timeouts, permission mode, usage estimate, digest). |
| `/agy doctor` | Check the `agy` version, bound conversation, driver stats, and bridge server status. |
| `/agy bridge all\|mcp\|none` | Change bridged tool scope live. Switching from `none` starts the bridge without `/reload`. |
| `/agy tools [hide\|show <name>\|reset]` | Inspect or toggle which Pi tools are bridged, with tab completion. |
| `/agy tasks [tail <id>]` | Browse background task logs (`Enter` tails 40 lines, `r` rescans), with tab completion on task IDs. |
| `/agy artifacts [open <n\|name>]` | Browse or open conversation artifacts, with tab completion on filenames. |
| `/agy quota` | Show model quota from `agy usage`. |
| `/agy clear [all]` | Clear the conversation binding for this Pi session, or `all` to clear every session. |

Settings and session bindings are stored in `~/.pi/agent/antigravity-bridge/` (or
`$PI_CODING_AGENT_DIR/antigravity-bridge/`).

## Development

```sh
npm install
npm test
```

Peer packages (`@earendil-works/*` and `typebox`) resolve from your host Pi installation and stay out of `node_modules`.

## License

MIT. See [LICENSE](./LICENSE).
