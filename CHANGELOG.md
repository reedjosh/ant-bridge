# Changelog

## 2.2.0 - 2026-11-12

- **Accurate per-turn usage and compaction isolation:** Normalize multi-inference `PromptResponse.usage` (`input_tokens`
  and `cache_read_tokens`) over each turn's tool batches so Pi's context-overflow check and context gauge see
  single-turn prompt counts instead of cumulative multi-inference billing sums. Isolate standalone compaction and
  branch-summary calls (`cacheRetention: "none"`) onto ephemeral tool-free turns without mutating `SessionStore` or
  streaming native tool events, and start a fresh compacted ACP session seeded once after Pi compacts a conversation.
- **`xhigh` thinking effort and model display labels:** Support 4-tier `xhigh` reasoning effort (such as
  `gemini-4-hydrogen`), project column-2 human display labels from `agy models` into Pi's `/model` picker, and align
  `FALLBACK_MODELS` with live discovery.
- **Prior-context seeding on `/fork` and provider switches:** Seed prior Pi transcript history once via `contextBlock`
  when starting a fresh Antigravity conversation mid-session while keeping subsequent bound turns cache-clean.
- **Session-scoped `/agy` commands and tab completion:** Scope `/agy clear`, `/agy tasks`, and `/agy artifacts` to the
  active Pi session (keeping `/agy clear all` for global resets), add `/agy` argument completions, and document
  `pi update --extensions`.
- **Clickable poll-run rows, live tool status details, and clean log shutdown:** Wrap `agy-poll-run` entries in
  `MouseRegion` for click-to-expand, include target details and active counts in live `agy-native` footer status, clear
  native status after buffered events drain, and flush `DailyLogger` during `session_shutdown`.

## 2.1.0 - 2026-11-12

- **Mid-turn steering interruption:** Send `session/cancel` to `agy acp` when the user steers during an active
  `session/prompt` turn (with a short grace period for running native tools and parked MCP round-trip protection),
  preserving `conversationId` and delta state so Pi immediately delivers the steering message on the next turn.
- **Native tool output and diff previews:** Show target file paths, line ranges, and search queries on `agy` native
  tool rows, clean `agy` command output wrappers, render 5-line collapsed tail/diff previews, and support per-entry
  left-click (`MouseRegion`) as well as global `Ctrl+O` expansion.

## 2.0.0 - 2026-11-12

Focused `ant-bridge` fork from `@estebanforge/pi-antigravity-bridge` 1.10.4:

- **ACP-only provider:** Removed legacy `stream-json` CLI engine, first-run engine picker, `AskAntigravity` tool,
  `agy_web_search` / `agy_read_url` tools, `WrapperReplay` dummy tool, shadow `bash`/`write`/`edit` tool overrides,
  hook scripts, and global `~/.gemini/config/mcp_config.json` mutations.
- **Pi 1.5 tool and codemode bridging:** Read live tool schemas and loadout descriptions dynamically via
  `getCurrentTools()` from `@earendil-works/pi-ai` and include `builtin:codemode`, `builtin:mcp`, and
  `builtin:tool-search` in `bridgeTools` (`all` and `mcp` modes) while excluding core file/shell builtins. Give
  `codemode` the same 120s escalation window as `subagent`.
- **Prompt and turn fixes:** Scan past trailing `custom_message` entries (such as `pr-tracker` status blocks) when
  extracting the latest user prompt, attached images, and context digest. Suppress redundant background-task wakeups
  when all tasks already finished during the turn.
- **Fresh-install conversation persistence:** Ensure `~/.gemini/antigravity-cli` exists before staging per-session ACP
  homes so first-run conversations persist across session cleanup.
- **Minimal dependency footprint:** Replaced `@estebanforge/pi-ask-shared` and `@estebanforge/pi-tui-dialogs` with
  native `@earendil-works/pi-tui` `SettingsList` components, leaving `@modelcontextprotocol/sdk` as the sole runtime
  dependency.
