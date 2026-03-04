# Orientation 2026-03-03

Cold boot — first session. All parts reporting initial assessments.

## Product

*Cold boot — building initial product picture from project sources.*

**Current product state:** Augment is a prototype-stage terminal management plugin for Obsidian (with standalone Electron aspirations). It provides: PTY-backed terminal panes via xterm.js, tiling layouts (tab, split-vertical, split-horizontal, 2x2 grid, sidebar), terminal rename, a fuzzy terminal switcher, a sidebar terminal manager with status dots, and orchestration-aware features that detect Claude Code team activity (TeamCreate, SendMessage) from terminal output. Session persistence via scrollback snapshots exists. The plugin is personal-use only — Matt is the sole user.

**Recent movement:** The last 5 commits added the per-project parts architecture scaffold and improved orchestration awareness — auto-opening member tabs when TeamCreate events are detected, emitting spawn hints from the terminal activity parser, and unifying terminal rename propagation. This represents a shift from basic terminal functionality toward agent-session management tooling.

**Feature assessment:**

- **Core terminal (PTY, xterm.js, resize, theme integration):** Functional. This is table stakes and works. No product concerns.
- **Terminal naming/rename:** Working. Random adjective-noun generation mirrors Claude Code's pane naming convention. Rename modal exists. Name persistence across sessions works via leaf state. Solid.
- **Tiling layouts (splits, grid):** Available via commands. Useful for multi-agent workflows. Right scope for current stage.
- **Terminal manager (sidebar panel):** Shows status dots, terminal names, unread counts, team/member metadata, clickable member chips that navigate to agent tabs. This is the most product-differentiated feature — it's becoming an agent session dashboard, not just a terminal list.
- **Orchestration detection (TeamCreate/SendMessage parsing):** Parses Claude Code terminal output via regex to detect team creation and messaging. Auto-opens tabs for spawned team members. This is novel and high-value for Matt's multi-agent workflow, but it's fragile — it depends on specific output patterns from Claude Code that could change.
- **Terminal switcher (fuzzy modal):** Functional. Useful when many terminals are open. Low complexity, appropriate.

**Scope concerns:**

- **Obsidian plugin vs. standalone Electron:** PARTS.md says "the standalone app is the current focus surface" but all code is an Obsidian plugin. No Electron shell exists in the repo. This is a latent scope question — building for Obsidian vs. extracting to standalone are different development paths. The decision doesn't need to be made now, but it should be tracked.
- **Orchestration parsing fragility:** The regex-based detection of Claude Code team events (`TOOL_PATTERN`, `TEAM_CREATE_ACTIVITY_PATTERN`, etc.) is coupled to Claude Code's output format. If CC changes its tool display format, parsing breaks silently. This is acceptable at prototype stage but is a scope risk if the feature is relied upon.
- **Session persistence is snapshot-only:** The scrollback buffer is captured and restored, but there's no process reconnection. When Obsidian restarts, terminal processes die and a new shell spawns. The "[Session restored]" message is honest about this. For personal use, this is fine.

**Recommendations:**

- **Prioritize the terminal manager panel as the primary product surface.** The status dots, unread counts, and member navigation are where Augment diverges from generic terminal plugins. Invest here — richer agent state display (what tool is running, how long it's been active, last message summary) would compound the value.
- **Add keyboard shortcuts for terminal switching.** Matt uses keyboard-heavy workflows. Cmd+1/2/3 to jump between terminal panes (or at least a hotkey for the switcher modal) would improve daily use.
- **Do not invest in Electron extraction yet.** The Obsidian surface works, Matt uses Obsidian daily, and extracting to Electron would be a large effort with no additional user to justify it. Revisit when the feature set stabilizes.
- **Track the orchestration parsing contract explicitly.** Document what CC output patterns the parser depends on, so when CC updates, the breakage surface is known.

## Values

*Cold boot — reading strategic and values context to establish alignment baseline.*

**Alignment check:** The Augment project is aligned with Matt's core values — specifically #5 (building and toolmaking as identity), #7 (sovereignty and augmentation), and #4 (fun as non-negotiable). This is a tool Matt builds and owns, it augments his capacity rather than replacing his judgment, and the revealed preference data (active development, Mac Mini infrastructure order, multiple Codex agent merges) indicates genuine enjoyment. The alignment is structurally sound.

**Purpose assessment:**
- Augment exists to give Matt (and eventually others) a terminal environment for Claude Code sessions that integrates with his thinking and knowledge system (Obsidian). The reason is live: Matt is actively building it, investing in supporting infrastructure (Mac Mini for always-on sessions), and developing the parts architecture scaffold (most recent commit). The project embodies the "missing island" thesis — human augmentation through tools you own.
- The vault strategy state raises a direct question worth holding: "is Relay the right product for the augmentation thesis? Matt's passion lives in Gus, not in Relay." Augment is where the passion is expressing. This doesn't make it the right business priority — but it does make the values alignment unambiguous.

**Observations:**
- The git log shows 11 commits, all infrastructure and developer-experience work: terminal session persistence, activity parsing, tab management, TeamCreate detection. No user-facing product polish. This is consistent with a builder scratching his own itch — building the tool he wants to use. Values-aligned.
- Commit `6c43b9d` (per-project parts architecture scaffold) created the system we're now running in. This is meta-toolmaking — building the tool that builds the tool. Matt's "toolmaking as identity" value is operating at multiple levels of abstraction here.
- The 80% pattern (documented in strategy state) is relevant: Augment is flagged as "NEW — early stage" in the 80% queue. It was added while mattobrien.org sits deploy-ready and the E2E report to Dan sits drafted-but-unsent for 4+ days. The values lens doesn't say "stop working on Augment" — but it notes that Augment's emergence follows the Splinter-Stage Hand pattern documented in therapeutic context: a new project appearing at the moment prior work reaches exposure threshold.
- The Splinter-Stage Hand pattern (strategy state, active): Stage Hand generates plausible productive work to avoid exposure. Augment is both genuinely productive AND a plausible Stage Hand object. The values framework cannot resolve this — only Matt's somatic check (static in back of head) can discriminate. This is the central question the Values part holds for this project.

**Concerns:**
- The only concern worth stating is the one the strategy state already identifies: is this project the highest-leverage use of Matt's building energy, or is it the most sophisticated form of the 80% pattern? Both are simultaneously supported by the evidence. This isn't a blocker — it's a question that deserves periodic revisiting, not continuous hand-wringing. Values part will track it.
- No ethical concerns. No privacy issues. No complexity-for-complexity's-sake. The codebase is lean (11 commits, personal tool).

**Affirmations:**
- The project is structurally values-aligned: owned tool, local-first, augments human capacity, builder-made. Keep building.
- The parts architecture decision (commit `6c43b9d`) is a good signal — Matt is designing for the kind of reflective, multi-perspective thinking that his therapeutic work says matters. Building reflection into the development process is integration work.
- Fun appears present. Active development across two days, Mac Mini infrastructure investment, Codex agents contributing — this has the energy signature of genuine engagement, not obligation.

## Design

*Cold boot — building initial design picture from codebase.*

**Current UX state:** The plugin provides an xterm.js terminal embedded in Obsidian leaves, with a sidebar manager panel and a fuzzy-match switcher modal. The interaction surface is minimal — open terminals, rename them, switch between them. Orchestration awareness (team detection, member tracking, unread badges) is layered on but entirely passive; the user sees it reflected in the manager panel but cannot act on it beyond clicking a member chip to jump to their tab.

**Interaction patterns observed:**

- **Open terminal (tab/split/grid/sidebar):** Five commands for placement. The grid command (2x2) is purpose-built for multi-agent sessions. The user can set up a workspace topology in one action.
- **Random name generation:** Each terminal gets an `adjective-noun` name (e.g., `sharp-gate`). Matches Matt's existing pane-naming convention from his vault tmux setup. Names feel native.
- **Rename modal:** Standard Obsidian Setting-based modal. Functional but slow — modal opens, user types, presses Enter. No inline editing. For a terminal-first user this is a detour.
- **Terminal switcher:** Obsidian's `FuzzySuggestModal` with status dots. Fast keyboard-driven switching. The best interaction pattern in the plugin. Shows status per terminal.
- **Manager panel (sidebar):** List of terminals with status dots, names, unread badges, team metadata, and member chips. Clicking a row focuses the terminal. Member chips navigate to that agent's tab. This is the main orchestration visibility surface.
- **Status detection:** Parses terminal output for Claude Code patterns (tool calls, ⏺ marker, idle prompt). Maps to five states: shell, idle, active, tool, exited. Reflected as colored dots in tabs and manager. Debounced at 150ms.
- **Session persistence:** Scrollback buffer (up to 200K chars) saved to leaf state. On restore, previous output is replayed into xterm with a `[Session restored]` notice, then a fresh shell starts. User sees prior context but is in a new process.

**Friction points:**

- **No terminal-to-agent binding.** Terminals and Claude Code sessions are decoupled. When TeamCreate fires and auto-opens tabs for members, those tabs are blank shells — the user must manually launch Claude Code in each one. The auto-open creates the expectation that agents will appear; they don't.
- **Orchestration data is read-only.** The manager panel shows teams and members but offers no actions — can't send messages, can't restart agents, can't inspect state. It's a status display, not a control surface.
- **Member chip navigation is fragile.** `findLeafForAgent` does three-tier matching (identity → exact name → partial name). Partial name matching could jump to the wrong terminal if names overlap.
- **No keyboard shortcut for cycling terminals.** The switcher is modal-based (type to filter). For rapid cycling between 2-3 terminals, a direct next/prev command would be faster.
- **Rename requires leaving the terminal.** The modal pulls focus away. Inline renaming (click the header title, type, Enter) would keep the user in flow.
- **Status colors don't distinguish tool from shell.** Both use `--color-green`. A user glancing at tabs can't tell if an agent is running a tool or if that terminal is a plain shell. These are different states with different meanings.
- **No visual indication of which terminal is the leader.** In a team session, one terminal is the coordinator. Nothing in the UI distinguishes it from spawned member terminals.
- **Grid layout is static.** The 2x2 grid command creates four terminals. If a team has 3 or 5 members, the layout doesn't adapt. The user must manually arrange.

**Design observations:**

- The plugin's mental model is "terminals with awareness," not "agent orchestrator." This is the right starting point — it stays close to what terminals actually are. But the orchestration features (team detection, member chips, auto-spawn tabs) push toward a second mental model where terminals represent agents. The gap between these two models is where confusion will live.
- Visual language is consistent. Monospace names, status dots, Obsidian CSS variables throughout. The manager panel mirrors Obsidian's file explorer patterns (list items, hover states, active state highlighting). Feels native.
- Information hierarchy in the manager is reasonable: name + status on the primary line, team metadata and members below. The unread badge draws attention correctly. The summary line (last team event) adds context without clutter.
- The CSS uses Obsidian's design tokens correctly. Dark/light theme handling comes from xterm theme integration reading CSS variables at mount time. No theme-specific overrides needed.

**Recommendations:**

- **Add next/prev terminal commands.** Register `cycle-terminal-forward` and `cycle-terminal-back` commands that move focus to adjacent terminal leaves without opening a modal. Keyboard-first users need this for rapid switching in multi-agent sessions.
- **Differentiate tool vs. shell status color.** Use a distinct color for `tool` state (e.g., `--color-cyan` or a brighter green) so status dots visually separate "agent running tools" from "plain shell."
- **Mark the leader terminal.** When a terminal's orchestration state shows it originated a TeamCreate event, add a visual marker (e.g., a small icon or different dot shape) in the manager panel. Helps the user know where to send commands.
- **Consider inline rename.** Replace the modal with a double-click-to-edit pattern on the header title or manager row name. Keeps the user in flow.
- **Address the auto-spawn gap.** When TeamCreate auto-opens member tabs, the tabs are empty shells. Either: (a) remove auto-spawn until terminals can launch agents, or (b) show a clear "waiting for agent" state in the blank tab so the user understands what's happening. Current behavior creates a broken expectation.
- **Adapt grid to team size.** When TeamCreate fires with N members, generate a layout that fits N+1 terminals (leader + members) rather than a fixed 2x2.

## CTO

*Cold boot — building initial technical picture from codebase.*

**Architecture summary:**

Five TypeScript modules, one Python script, one CSS file. ~1,400 lines of TypeScript total.

- `main.ts` (316 lines) — Plugin entry point. Registers two view types (terminal, terminal manager), eight commands (open, split-vertical, split-horizontal, grid, sidebar, rename, manager, switcher). Handles `TeamCreate` spawn events by opening named terminal tabs for new team members. Deduplicates spawn events by signature within a 15-second window.
- `terminal-view.ts` (723 lines) — The core module and largest file. Hosts an xterm.js `Terminal` instance inside an Obsidian `ItemView`. Manages: PTY bridge lifecycle, terminal resize via `ResizeObserver` + `FitAddon`, scrollback snapshots (200K char cap), session state persistence via `getState()`/`setState()`. Contains the orchestration activity parser (~250 lines, lines 440-615) that detects `TeamCreate` and `SendMessage` events from terminal output via 9 regex patterns. Tracks agent identity, team membership, unread activity counts. Emits `augment-terminal:teamcreate` and `augment-terminal:changed` workspace events. Status detection (shell/idle/active/tool/exited) is debounced at 150ms.
- `terminal-manager-view.ts` (276 lines) — Sidebar panel. Lists open terminals with status dots, names, unread badges, team/member metadata, clickable member chips. Three-tier agent lookup: identity → exact name match → partial name match. Refreshes on layout-change, active-leaf-change, and custom `augment-terminal:changed` events.
- `pty-bridge.ts` (79 lines) — Node.js wrapper spawning `terminal_pty.py` via `child_process.spawn`. Three channels: stdin (terminal input), stdout (terminal output), fd 3 (control channel for resize commands). Sends `SIGTERM` on kill.
- `terminal-switcher.ts` (44 lines) — `FuzzySuggestModal` subclass. Fuzzy search across terminal names with status dots.
- `terminal_pty.py` (155 lines) — Python PTY bridge. `pty.openpty()` + `os.fork()` → child exec's `$SHELL -l`, parent bridges I/O via `select.select()`. Control fd 3 for resize (`TIOCSWINSZ` + `SIGWINCH`). Stdlib only.

Data flow: User keystroke → xterm.js `onData` → `PtyBridge.write()` → Python stdin → PTY master → shell. Output: shell → PTY master → Python stdout → `PtyBridge` `onData` callback → `terminal.write()` + scrollback append + status detection + orchestration parsing → workspace event triggers → manager panel refresh.

**Build status:** PASS. `npm run build` completes with zero errors. esbuild bundles `src/main.ts` → `main.js` (CJS, ES2018 target). CSS files loaded as text strings via esbuild's `{ ".css": "text" }` loader and injected into `document.head` at runtime via a shared `<style>` element.

**Codebase health:**
- No automated tests. `test:rename-sync` is a manual verification script (`scripts/check-rename-sync.mjs`), not a test runner.
- `noImplicitAny: false` in tsconfig — several `as any` casts on Obsidian workspace internals. Expected for Obsidian plugin development (many internal APIs aren't typed), but reduces type safety.
- Code is readable, single-responsibility per module, clear naming. No dead code in source (aside from unused dep).
- No linting or formatting tools configured.
- `strictNullChecks: true` is enabled — good.

**Recent technical changes:**
- `6c43b9d` — Added `.parts/` scaffold (SKILL files, state files, PARTS.md). No code changes.
- `54f8005` through `c4d0a94` — Built TeamCreate auto-spawn pipeline: terminal output parser detects `TeamCreate` tool calls → extracts member names → emits workspace event → plugin opens named tabs. Includes deduplication (signature-based, 15s window, 150-entry LRU).
- `0c36a82`, `e735eee` — Unified terminal rename propagation: header title, tab header, manager panel, and persisted leaf state all update from a single `setName()` call. Fix contributed via Codex on `codex-fix-rename-sync-tab-manager` branch.
- Foundation: initial xterm.js + PTY bridge, session persistence, status detection, terminal manager panel.

**Technical debt:**

- **Orchestration parser fragility (medium).** The regex-based parser in `terminal-view.ts` (9 patterns, ~175 lines of parsing logic) matches Claude Code's terminal output format. Any change to CC's tool display, agent naming, or mailbox logging breaks detection silently. The parser constitutes >30% of the largest file. No way to test it without running actual CC sessions.
- **Duplicated `getLeafTerminalName()` (low).** Implemented independently in `terminal-manager-view.ts:249-275` and `terminal-switcher.ts:36-43`. Same three-tier fallback logic, slightly different implementations. Will drift.
- **Unused dependency: `@xterm/addon-serialize` (low).** Listed in `package.json` but not imported anywhere in source. Dead weight.
- **No orphan process cleanup (low).** `PtyBridge.kill()` sends `SIGTERM` and the Python script's `finally` block cleans up the child shell. But if the Electron/Obsidian process terminates abruptly (crash, force-quit), the Python process may orphan. No process group management or PID tracking.
- **String concatenation for scrollback (low).** `appendToScrollback` appends to a string buffer capped at 200K chars. In long sessions this creates large intermediate strings for GC. Not a problem at current scale but worth noting for future.
- **`obsidian: latest` in devDependencies (low).** Not pinned. Builds are not reproducible if the Obsidian API package changes.

**Dependency status:**

| Package | Version | Status |
|---------|---------|--------|
| `@xterm/xterm` | ^5.5.0 | Current, actively maintained |
| `@xterm/addon-fit` | ^0.10.0 | Current |
| `@xterm/addon-web-links` | ^0.11.0 | Current |
| `@xterm/addon-serialize` | ^0.13.0 | **Unused in source** — remove |
| `esbuild` | ^0.21.0 | Current |
| `typescript` | ^5.4.0 | Current |
| `obsidian` | latest | Unpinned — pin to range |
| Python stdlib | — | No external deps |

No known security advisories on current dependency versions.

**Technical recommendations:**

- **Remove `@xterm/addon-serialize` from package.json.** Not imported. (Small)
- **Extract `getLeafTerminalName()` to a shared utility.** Prevents drift between manager and switcher. (Small)
- **Pin `obsidian` to a version range** (e.g., `^1.5.0`) for reproducible builds. (Small)
- **Add `tsc --noEmit` as a CI check or pre-commit hook.** Catches type regressions. (Small)
- **Consider structured orchestration protocol.** The regex parser is the highest-risk code in the repo. A structured channel (e.g., CC writes JSON events to a file, or uses fd 3-style control messages) would eliminate the parsing fragility. This depends on upstream CC changes and may not be actionable now, but it's the correct long-term direction. (Large — upstream dependency)
- **Add process group isolation for PTY processes.** Spawn Python bridge in its own process group so cleanup can kill the entire group on shutdown, preventing orphans. (Medium)

## Visionary

*Cold boot — building initial landscape picture from web research and project context.*

**Landscape snapshot:**

The agent-terminal-IDE space as of March 2026, based on web scan:

- **Warp** pivoted from "modern terminal" to "agentic development environment." Warp Code ships a built-in agent (Oz), file editor, code review tools, and first-party integrations (Slack, Linear, GitHub Actions). Their agent interacts with interactive terminal applications (debuggers, database shells) — not just command-and-read-output.
- **Claude Code agent teams** (experimental) coordinate multi-session work with in-process or tmux split-pane modes. Claude Code Desktop (Electron) embeds CC in a GUI. Third-party wrappers proliferated: opcode (Tauri), CodePilot (Electron+Next.js), Pilos Agents (Electron), Claude Code UI (web/mobile). All add visual management on top of CC's CLI.
- **claude-squad** (smtg-ai) manages multiple AI terminal agents using tmux + git worktrees for workspace isolation. NTM (Named Tmux Manager) tiles agents in tmux panes with a TUI. Both terminal-native, no GUI.
- **Happy** is an open-source mobile+web client for Claude Code with E2E encryption (TweetNaCl/Signal protocol), bidirectional real-time sync between desktop CLI and mobile app, voice coding, push notifications. iOS, Android, web. Closest existing thing to "mobile Gus."
- **Obsidian entries:** Obsidian-AI-CLI integrates Claude Code and Gemini CLI into sidebars. Obsidian Vault Agent adds terminal+AI support. Claude Sidebar embeds CC in Obsidian sidebar. Original Obsidian Terminal plugin (polyipseity) uses xterm.js. None combine terminal management with orchestration awareness.
- **VS Code 1.109** branded itself "the home for multi-agent development" with first-class orchestration features. IDE vendors see agent orchestration as a core IDE capability.

**Trajectory observations:**

- Agent session management is becoming a product category. Six months ago, running CC meant one terminal. Now dedicated tools manage agent fleets (claude-squad, NTM, Warp Code, CC agent teams). Direction: "run one agent" → "orchestrate many." Augment is in this trajectory.
- The GUI wrapper market for CC is crowded and undifferentiated. opcode, CodePilot, Pilos Agents, Claude Code UI — all skins, not tools. None solve orchestration.
- Terminal-native tools (tmux-based) serve power users but cap out at rich state visualization. Gap between tmux-native and full GUI wrapper — Augment sits here.
- Mobile access to agent sessions is emerging. Happy proves the pattern. Matt's Mac Mini (arriving Mar 4) makes always-on sessions imminent.
- IDE vendors are absorbing agent orchestration. Compression risk for standalone tools — but only if the user's workflow fits one IDE. Matt's workflow spans Obsidian + terminal + multiple project dirs.

**Opportunities:**

- **Orchestration-aware session management is Augment's moat.** Nobody else parses CC output to detect team creation and auto-manage session tabs. Deepen this: richer agent state (current tool, elapsed time, last message summary), team topology visualization, bidirectional control (send messages from the manager panel).
- **Bridge to Mac Mini / always-on infrastructure.** Manage remote CC sessions over SSH/Tailscale — control plane for a distributed agent fleet. No competitor does this.
- **Vault-context injection into agent sessions.** Augment runs inside Obsidian with vault graph access. "Start a CC session with context from these vault notes" is a first-class feature no standalone tool can offer.

**Risks to current direction:**

- **CC output format instability.** Orchestration detection depends on regex parsing. No structured event stream exists for CC team activity. Format changes break silently.
- **Anthropic ships native agent session management.** If CC Desktop adds team visualization and orchestration UX, Augment's feature set becomes redundant. 6-12 month timeline risk.
- **Obsidian surface constraint.** Obsidian-only distribution limits addressable audience if the product finds users beyond Matt.

**Recommendations:**

- **Investigate CC's structured output options.** Does CC emit structured events (JSON, fd 3, hooks) that could replace regex parsing? Highest-leverage technical investigation.
- **Study Happy's architecture.** E2E encrypted relay pattern is directly relevant to Mac Mini remote access. Understand session state sync, reconnection, latency.
- **Do not compete on "prettier CC wrapper."** Market is crowded, commodity. Augment's value: orchestration awareness + vault integration + session management.
- **Track Warp Code's interactive terminal agent feature.** If CC adds similar capabilities, Augment needs to handle richer interaction patterns. Watch, don't act.
