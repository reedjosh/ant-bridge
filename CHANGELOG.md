# Changelog

## 2.5.1 - 2026-11-27

- Keep native `read_file` enabled in `pi-only` mode so real images and large `.system_generated/` MCP outputs that `agy`
  offloads to disk remain readable, while all native write, edit, shell, subagent, schedule, and question tools stay
  disabled (#12).
- Persist `toolMode` per bound session and automatically start a fresh seeded `agy` conversation on the next turn when
  switching between `hybrid` and `pi-only`, removing the need for `/agy clear` (#12).

## 2.5.0 - 2026-11-27

- Add opt-in `pi-only` tool mode (`/agy tool-mode pi-only`, `/agy` settings picker, or `AGY_TOOL_MODE=pi-only`) to
  disable `agy`'s native workspace and agent tools and route all tools through Pi over MCP (#11).
- Stage per-session isolated `config/mcp_config.json` and `config/agents/pi-bridge.md` with compact parameter schemas
  (including nested object/array shapes and enums) so turn-one `call_mcp_tool` calls need no extra discovery step, and
  clean up per-session dirs on connection exit.
- Give `bash` and `powershell` the 120s synchronous foreground window before `STILL RUNNING` escalation.
- Document `tool-mode` in `README.md`.

## 2.4.6 - 2026-11-27

- Collapse successful native command output to its header line until expanded (#3, @lansmurf).
- Prohibit native `agy` background tasks, daemons, and subagents in bridge guidance, stop prior-turn watchers on
  `turn_start` to prevent stale wakes, and collapse carriage-return progress overwrites in wake tails (#10).
- Simplify `README.md` and drop Pi 1.5 version callouts.

## 2.4.5 - 2026-11-27

- Pause the idle stall guard while native `agy` tools are in flight so long-running commands do not trigger false
  stalls.
- Raise the default headless turn timeout to 40 minutes.
- Rewrite `README.md` in plain technical style and remove legacy fork migration notes.

## 2.4.4 - 2026-11-13

- Continue automatically after compaction without requiring a new user message, preserving the compacted checkpoint
  and latest retained tool results. Defer the compaction watermark until the new context is actually delivered.
- Isolate child-session summarization from parked turns so compaction cannot deadlock behind a pending tool result.
- Wake Pi for native background results unless an in-turn model inference consumed them; hidden native responses
  after Pi's turn ended must not suppress the wake. Handle completion racing with watcher arming.
- Validate with 84 passing tests and live Carbon checks for automatic compaction, compacted-session continuation,
  and background wake recovery without another user message or rerunning the completed job.

## 2.4.3 - 2026-11-13

- Recover Carbon conversations blocked by native `ask_question`: detect the call during live output and suppressed
  history replay, then deliver the next user reply to a fresh ACP session seeded with the Pi transcript.
- Explicitly prohibit native `ask_question` in the tool guidance; use Pi questions or plain-text questions instead.
- Verify recovery against a live blocked Carbon session and cover fresh questions, loaded questions, single-stream
  completion, transcript preservation, and unrelated MCP question tools in regression tests.

## 2.4.0 - 2026-11-12

- **Per-namespace MCP routes (`pi-bridge-<server>`):** Partition direct Pi MCP tools (`mcp__<server>__<tool>`) onto
  dedicated loopback HTTP routes (`/mcp/ns/<server>`, registered with `agy acp` as `pi-bridge-<server>`) while keeping
  core extension, codemode, skill, and poll tools on `pi-bridge` (`/mcp`), exposing short tool names with collision
  fallback and routing `tools/call` back to Pi so direct MCP calls render as clean `<server>/<tool>` rows.
- **Automatic catalog-change driver recycle:** Fingerprint the active bridged tool and skill catalog before normal
  turns and on `/agy bridge` and `/agy tools` (`hide`, `show`, `reset`) changes, automatically recycling warm `agy acp`
  connections and reloading the bound `conversationId` via `session/load` while skipping recycles during parked
  `reentry()` continuations and standalone summarization turns.
- **MCP instructions, fast-fail probes, and event suppression:** Serve `PI_BRIDGE_INSTRUCTIONS` via
  `InitializeResult.instructions` across all `pi-bridge*` routes, fast-fail `server/discover` (`-32601`) and
  `/.well-known/*` (`404`) probes without instantiating MCP servers, filter `pi-bridge-*` entries when staging
  `acp-home`, and suppress duplicate native tool rows for both eager `mcp_pi-bridge-*` and lazy `call_mcp_tool` calls.
- **Refined tool-priority and codemode output guidance:** Update `TOOL_PRIORITY_NOTE` and `README.md` to cover
  `direct`, `codemode`, and `deferred` MCP server exposure and guide `codemode` scripts to emit readable multi-line
  `text(...)` strings instead of returning raw or nested JSON objects.
- **Child subagent MCP isolation and non-greedy namespace routing:** Scope child subagent MCP server prefixes to
  `pi-bridge-s<pid>` (`PI_SUBAGENT_CHILD=1`) so `agy acp` schema writes in shared `acp-home` never collide with the
  parent session, reap stale dead-PID `pi-bridge-s<pid>*` directories on startup, split `mcp__<server>__<tool>` names
  non-greedily when upstream tool names contain `__`, and record `lastSyncedCatalogFingerprint` on initial ACP spawn.
- **Out-of-turn permission, bridge failure, and native status hardening:** Honor `skipPermissions` for out-of-turn
  `session/request_permission` requests, preserve `call_mcp_tool` `mcpServer` metadata across `tool_call_update` frames
  while balancing `pendingNativeTools` on late suppression, format `call-tool-fail` TUI notices as readable prose with
  per-turn deduplication when no Antigravity turn is active, and warn against native background subagents across turns
  in `TOOL_PRIORITY_NOTE`.

## 2.3.0 - 2026-11-12

- **Live Pi skill catalog and multi-line frontmatter:** Populate `activate_skill` from `pi.getCommands()` so skills
  installed via Pi packages and `settings.json` appear alongside filesystem scans, and parse YAML block scalars (`>`,
  `|`) and quoted strings cleanly in skill descriptions.
- **Persistent ACP home and stale directory sweeps:** Reuse a stable `~/.pi/agent/antigravity-bridge/acp-home/` across
  sessions with atomic config refresh so `file://` artifact and brain links remain valid after reloads, while sweeping
  orphaned `acp-homes/*` and legacy `1.x` `agy-mcp-*` directories.
- **Hardened `SessionStore` and config writes:** Serialize writes per path with unique `.tmp` filenames, unlink failed
  writes, sweep dead-PID temp files, flush pending `SessionStore` writes during `session_shutdown`, and start the MCP
  bridge immediately when `/agy bridge` switches out of `none`.
- **Usage footer and `/agy` UX polish:** Suppress `0 in / 0 out` footer flicker before token updates arrive, distinguish
  native exact usage (`+N cached`) from estimates, open task log tails on `Enter` in `/agy tasks`, complete task IDs and
  artifact names on tab, and show the active Pi session's bound conversation in `/agy` and `/agy doctor`.
- **1.x `stream-json` cleanup:** Remove dead `lastStepIdx` session fields, `AskAntigravity` bridge catalog exclusions,
  unused diff-input and version constants, and stale `stepId` references, and stub `GitOps` during standalone compaction
  turns.

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
