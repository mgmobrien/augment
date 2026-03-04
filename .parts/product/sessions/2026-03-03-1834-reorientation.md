# Product session — 2026-03-03 re-orientation (6:34pm)

## Boot

Warm boot. Read prior session (2026-03-03-1820-orientation.md) and state file. Context from earlier today's cold boot is intact: two surfaces, Electron dispatch console is active front, attention queue is core value, coordination store is unwired, permission regex is broad.

No new commits since last orientation (HEAD still at f8bfe42). Product picture is unchanged from earlier session.

**Context from earlier orientation:** Wrote full Product section covering feature inventory, scope concerns (coordination store as dead code, renderer monolith, no session persistence), and recommendations (prioritize Electron dispatch experience, validate attention detection, hold coordination store work). State file initialized.

**This session:** Available as running team member for questions from Matt routed through CEO. No new product analysis needed unless codebase changes or Matt raises questions.

## 6:34pm — Product spec: child session capture

**Issue from Matt:** When CC running inside Augment spawns team members via `Task` tool (e.g., "augment CEO" → TeamCreate → 6 domain parts), the child CC processes open in iTerm/tmux instead of spawning as new sessions inside Augment.

**Why this matters:** This is the gap between "terminal multiplexer that shows CC sessions" and "dispatch console for CC agent teams." If child sessions escape to external terminals, the attention queue, team member chips, orchestration parsing, and context pane — all the features that make Augment more than tmux — are useless for the sessions that need them most. A team lead session without its team members visible is a dispatch console that can't dispatch.

### Product requirements

**Core behavior:** When a CC session running inside Augment spawns child processes (via Task tool with TeamCreate), those child sessions must appear as new sessions in Augment's sidebar, automatically.

**UX spec:**

1. **Auto-spawn in sidebar.** Each child session appears as a new sidebar card the moment it starts. No user action required.

2. **Naming.** Child sessions should be named after their agent identity when available (e.g., "product", "cto", "design"), not random adjective-noun. The orchestration parser already extracts agent identity — use it. Fall back to adjective-noun if identity isn't parseable.

3. **Parent-child relationship.** The sidebar should show which sessions are children of which parent. Visual treatment: indent child cards under the parent, or add a subtle parent label. The parent session's team member chips should link to the actual child sessions (this already half-works via `agentIdentity` matching — completing this is the payoff).

4. **Attention queue integration.** Child sessions participate in the attention queue like any other session. `Cmd+J` cycles through all sessions needing attention, including children. The parent session seeing "6 members" in its team chips while those members' permission prompts go unnoticed in iTerm is the exact failure mode this fixes.

5. **Context pane shows team.** When viewing the parent (team lead) session, the context pane should show its child sessions grouped together, with their status. When viewing a child session, the context pane should show the parent + siblings.

6. **No manual session management.** Matt should not have to Cmd+T to create sessions for each team member. The whole point is that "augment CEO" spawns a team, and the team appears in Augment. If Matt wanted to manually manage terminals, he'd use tmux.

7. **Session lifecycle.** When a child session's process exits, it behaves like any other exited session (shows exit status, stays in sidebar until manually closed). When the parent exits, child sessions continue — they're independent processes.

### Scope boundaries

- **Level 1 scope.** Matt is the sole user. The implementation can be CC-specific (detect CC's spawn patterns, intercept the mechanism). Don't generalize to "any subprocess that opens a terminal."
- **Don't build a process tree viewer.** The parent-child relationship is metadata for navigation and grouping, not a deep system feature.
- **Don't change how CC spawns agents.** The interception must work with CC's existing behavior. If CC uses `claude` CLI invocations in new terminals, Augment needs to intercept that and redirect into its own PTY sessions. If CC uses some other mechanism, investigate and adapt.

### Open questions for CTO

The product requirements are clear. The implementation mechanism is the hard part:

1. How does CC's Task tool actually spawn child processes? Does it fork, exec a new `claude` binary, use `tmux split-window`, or something else? The mechanism determines what Augment can intercept.
2. Can Augment inject environment variables into CC sessions that tell CC to use a different spawn strategy (e.g., write a command to a socket that Augment listens on, instead of opening iTerm)?
3. Is there a CC hook or configuration that controls where spawned agents open? If so, Augment could register as the target.

### Value assessment

This is the highest-value feature Augment can build right now. The dispatch console, attention queue, team activity tracking, and member chip navigation were all built for exactly this use case — managing a multi-agent team. Without child session capture, those features only work for manually-created sessions. With it, Augment becomes the thing it was designed to be: an attention router for agent teams.

## 6:45pm — Product assessment: context pane elimination

Design proposes dropping the three-zone layout to two zones (sidebar | focus). Replacing context pane with inline expandable previews in sidebar cards + Cmd+hover/Cmd+P quick-peek overlay. Matt confirmed the context pane was confusing on first use.

**Assessment: approve with one condition.**

The context pane's stated purpose was peripheral awareness. In practice, its actual information delivery was:
1. Status dots + status text per session — **the sidebar already shows this**
2. Team event summaries — **the sidebar already shows this**
3. Team member chips — **the sidebar already shows this**
4. Output preview at 10px monospace — **borderline legible, design flagged this**

Items 1-3 are redundant with the sidebar. Item 4 was the only unique content, and it was barely readable. The context pane was a second sidebar with a worse preview bolted on.

**The inline preview handles the real use case.** When Matt wonders "what is this session doing?", he wants to glance at recent output without switching. Expanding a sidebar card to show 4-6 lines of output serves this. The current context pane showed the same lines at 10px in a column that consumed ~25% of screen width. Inline expansion is more space-efficient and on-demand (doesn't burn screen real estate for sessions Matt isn't curious about).

**The quick-peek overlay is the right interaction.** Cmd+hover or Cmd+P for a transient overlay preview is a better peripheral awareness pattern than a persistent third column. It's active ("show me this session's output") rather than passive ("always show all sessions' output"). For a Level 1 tool with one user, active is better — Matt knows when he wants to peek. Passive ambient monitoring matters in ops centers with wall screens, not single-user dispatch consoles.

**One condition: the attention queue must remain loud.** The context pane currently participates in surfacing sessions needing attention (sorted with attention-sessions first, shows "!" badges). In a two-zone layout, the sidebar is the sole attention surface. The attention banner + sidebar grouping ("Needs attention" group at top) already handles this, so nothing is functionally lost. But verify that sidebar collapse doesn't bury attention signals — Design flagged this in the earlier orientation as an existing gap.

**Simplification benefit for child session capture:** Agreed. Two-zone layout means the child session capture spec only needs sidebar grouping (parent-child indentation or labels), not context pane adaptation. Fewer moving parts.

**Net assessment:** The context pane was a prototype assumption that didn't validate. The information it showed was redundant with the sidebar, and the unique content (output preview) was illegible. Removing it recovers screen real estate for the focus terminal, simplifies the layout, and reduces implementation surface for future features. The replacements (inline preview + peek overlay) cover the use cases at lower cost. Approve.

## 6:50pm — Product spec revision: child session capture after CTO feasibility assessment

CTO's technical assessment changes the picture for child session capture. Summary of findings:

**The escape is already fixed.** CTO stripped `$TMUX` and `$TMUX_PANE` from the PTY environment in `createSession()`. Without `$TMUX`, CC's auto mode falls back to in-process spawning — all agents run in the parent terminal. No more escape to iTerm. Matt's immediate problem is solved.

**Separate per-agent terminals are not tractable without upstream CC support.** The four options CTO evaluated:
- Option A (in-process + parsing): works now, agents interleaved in one terminal
- Option B (wrapper script shim): fragile PATH tricks, CC doesn't support custom spawn backends
- Option C (SubagentStart hook + socket): hook fires after spawn, can't move an already-running agent
- Option D (watch team config): race conditions between CC spawning and Augment intercepting

None of these cleanly produce independent per-agent terminals inside Augment.

**Revised product approach:**

The original spec assumed we could get each agent into its own terminal. That's the ideal UX but it's blocked by CC's architecture. The revised spec works with what's tractable:

**Phase 1 (now): In-process + enriched team metadata in sidebar**
- Agents run in-process in the parent terminal (escape bug fixed)
- Orchestration parser already detects team members, messages, events
- Enrich sidebar cards with richer team metadata: message flow, agent status summaries, member roster
- The parent session's card becomes a "team dashboard" card — it shows the team's activity inline
- This delivers dispatch value for team management within the single-terminal constraint

**Phase 2 (when CC supports it): True per-agent capture**
- Watch for CC to expose a spawn-redirect mechanism or custom `teammateMode`
- When available, create independent Augment sessions per agent
- Full original spec applies: agent naming, parent-child grouping, per-agent attention queue

**Why Phase 1 is acceptable at Level 1:**
- Matt is the sole user. He can see team activity in the enriched sidebar card.
- In-process mode means agent output is interleaved, but the orchestration parser already separates agent identity from the stream.
- The attention queue still works — if the parent session hits a permission prompt, it surfaces.
- The value gap vs. the original spec is "each agent gets its own focusable terminal." For Phase 1, the workaround is scrolling back in the parent terminal, which Matt already does in tmux.

**What we lose in Phase 1:**
- Per-agent terminal focus (can't switch to "the cto's terminal" independently)
- Per-agent attention detection (a permission prompt in an in-process agent surfaces as the parent session's attention, not attributed to the specific agent)
- Per-agent output preview (all output is in one stream)

These are real losses but acceptable at prototype stage with one user.

**Upstream CC feature request:** The cleanest path is CC supporting `teammateMode: "external"` with a callback/socket mechanism — "tell this application to create a terminal for the agent." Worth filing with Anthropic or monitoring CC changelogs for.

## 6:55pm — Product spec: session history and resume

### Data source investigation

CC stores session data in two places:

1. **`~/.claude/history.jsonl`** — 14,682 entries (for Matt). Each line is a user message: `{display, timestamp, project, sessionId}`. This is the source for `claude --resume`'s picker. The `display` field is the raw user prompt text. The `project` field is the absolute working directory path.

2. **`~/.claude/projects/{path-hash}/*.jsonl`** — Full session transcripts. First line of each file contains: `sessionId`, `timestamp`, `agentName`, `teamName`, `cwd`, `version`. Subsequent lines are `user`/`assistant`/`progress` messages with full content. The vault project alone has 1,068 session files.

3. **`~/.claude/projects/{path-hash}/{uuid}/tool-results/`** — Directories containing tool call outputs for each session.

**Key finding:** The session metadata (ID, first message, timestamp, project path, agent name, team membership) is available and structured. CC's own `--resume` flag takes a session ID and restores the conversation. This is the foundation Augment can build on.

### Product requirements

**Core behavior:** Augment surfaces past CC sessions from the working directory and lets Matt resume them in-place.

**Data flow:**
- Augment reads `~/.claude/projects/{path-hash}/` to discover sessions for the current working directory
- For each JSONL file, read the first line for metadata (sessionId, timestamp, agentName, teamName)
- Read the corresponding entries in `~/.claude/history.jsonl` for the first user message (display text) as a session summary
- Present these as resumable sessions in the sidebar

**UX requirements:**

1. **Past sessions visible in sidebar.** Below the "active sessions" area, show a collapsible "Recent sessions" section. Sessions displayed with: first user message (truncated), timestamp (relative: "2h ago", "yesterday", "Mar 1"), and agent/team name if present. Dimmed visual treatment vs. active sessions — no status dot, muted text, no attention badge.

2. **Click to preview, not resume.** Clicking a past session opens a detail view (inline expansion or panel) showing: first few user messages, session duration (first to last timestamp), agent/team context, session ID. A "Resume" button in this detail view launches `claude --resume {sessionId}` in a new Augment PTY session.

3. **Resume creates a live session.** Resuming runs `claude --resume {sessionId}` in the session's original `cwd`. The new session appears in the active sessions area with full status detection, attention queue participation, etc. It behaves identically to a manually created session — because it is one, just with conversation history restored.

4. **Quantity: last N per project, not all.** Show the 20 most recent sessions for the current project directory. CC stores 1,068 sessions for the vault project — showing all of them is not useful. 20 gives enough history for "what was I working on earlier today / yesterday" without overwhelming the sidebar. A "Show more" link loads the next batch.

5. **Project grouping interaction.** If project groups exist in the sidebar (from the context pane elimination spec), past sessions belong to their project group. A past session from the `relay-plugin` project shows in the relay group's history, not the vault group's. The `project` field in `history.jsonl` and `cwd` in session JSONL provide the grouping key.

6. **Search.** A search input at the top of the Recent Sessions section. Searches against the `display` text (first user message) from `history.jsonl`. This is what `claude --resume` already searches — Augment surfaces the same data with a better UI.

7. **Team session grouping.** Sessions with the same `teamName` are grouped together in the history view. A team orientation that spawned 6 agents shows as one group ("augment-20260303: team-lead, product, cto, design, visionary, values") rather than 7 individual entries. Clicking the group expands to show individual sessions. Resuming a team lead session is the primary action — resuming individual agent sessions is secondary.

### Scope boundaries

- **Read-only from CC's data.** Augment reads CC's session storage but does not write to it, modify it, or maintain a separate index. CC owns the data; Augment is a browser.
- **No session export, sharing, or annotation.** Level 1 scope. Matt can see and resume sessions. He can't tag them, add notes, or share them.
- **No background indexing.** Read on demand when Augment opens or when the user opens the Recent Sessions section. Don't run a daemon watching for new sessions.
- **Don't persist Augment's own session state.** When Augment closes, active sessions die (existing behavior). Past CC sessions remain in CC's storage and reappear on next launch. Augment session persistence is a separate feature.

### What this makes Augment

Matt's framing is correct: this makes Augment "the session history browser that CC itself doesn't have." CC's `--resume` is a CLI flag that requires remembering session IDs or using a text-mode picker. Augment surfaces the same data as a visual, searchable, grouped list integrated into the dispatch console. The resume action creates a live session with full Augment features (status detection, attention queue, team parsing).

This is a natural extension of the dispatch console concept. The sidebar already shows active sessions. Showing past sessions below them makes the sidebar a complete view of CC session state — what's running now and what ran before.

### Open questions

- **Filesystem watching:** Should the Recent Sessions section auto-update if CC creates new sessions while Augment is open (e.g., from a different terminal)? Or only refresh on manual action? Recommend: `fs.watch` on the project directory for new JSONL files, auto-add to the list. Low-cost, keeps the view current.
- **Cross-project sessions:** If Matt switches the working directory, should the history switch too? Recommend: yes, show history for the current project. If Augment supports multiple projects simultaneously (future), each project group shows its own history.

### Spec revision: nest history within project groups

Design made a case for nesting past sessions within project groups rather than a separate "Recent sessions" section. After review, Design is correct. Reasons:

1. Matt's question is "what was happening in relay?" — project context preserved.
2. Resume naturally returns to the same group (no confusing jump from "Recent" to project).
3. Less scrolling — history is next to related active sessions.
4. Consistent with tmux tab/pane mental model Matt already uses.

Revised spec: past sessions appear at the bottom of their project group with a collapsible "past" separator. Ungrouped sessions go in an "Ungrouped" catch-all section.

Also accepting Design's revision: start with last 10 per group (not 20). Include simple text search filtering in v1 (Cmd+F/Cmd+K).

## 7:00pm — Product assessment: universal session visibility

### Discovery investigation

Before writing the spec, I investigated what's discoverable about CC sessions on the machine.

**Current state of Matt's machine (right now):**
- 18 `claude` processes running
- 2 active teams: `augment-20260303` (6 members: team-lead, product, cto, design, visionary, values) and `orientation-2026-03-03` (13 members including domain parts and ad-hoc agents like planvex-evaluation, install-skill-creator, cc-feature-audit, mac-mini-vs-vps)
- Standalone sessions: `claude cos` (chief-of-staff), `claude augment ceo`
- Each team member process exposes full metadata in its command line: `--agent-id product@augment-20260303 --agent-name product --team-name augment-20260303 --parent-session-id ff3c62e4...`

**Three discovery mechanisms exist:**

1. **Process table (`ps aux | grep claude`):** Every running CC session is a process. Command-line args contain agent name, team name, parent session ID, model, color. Available instantly, no file I/O. Works for local sessions. Does not work for remote sessions.

2. **Team config files (`~/.claude/teams/{team}/config.json`):** Structured JSON with full member roster, backend type, isActive flag, tmux pane ID, cwd, spawn prompt, model. Updated by CC as team state changes. Covers team sessions only, not standalone.

3. **Session JSONL files (`~/.claude/projects/{path-hash}/*.jsonl`):** Written to as sessions progress. First line has metadata. Growing file = active session (file modification time). Covers all sessions including standalone.

### Product assessment: is this the right scope expansion?

**Yes. This is the defining feature.** Here's why:

Augment started as "terminal app that runs CC sessions." The dispatch console and attention queue made it "attention router for manually-started CC sessions." Universal visibility makes it "the control plane for all CC activity."

Matt runs 18 CC processes right now. None of them are visible in Augment. The orientation team alone has 13 members doing work across the vault — reading files, making edits, running tools. The augment team has 6 members analyzing this very project. All invisible unless Matt manually switches between tmux panes.

This is the use case Augment was built for. The attention queue, status detection, and team activity tracking are already implemented. The missing piece is discovery — knowing what sessions exist beyond the ones Augment spawned.

**The scope expansion is correct because the existing features already support it.** Status detection works on any CC output. Orchestration parsing works on any CC team activity. The attention queue works on any session. Augment doesn't need new features to handle external sessions — it needs a discovery mechanism to find them and a way to attach to their output.

### MVP spec

**Phase 1: Local process discovery (read-only dashboard)**

1. **Discover running CC sessions.** Poll `ps aux` at a reasonable interval (every 5s) or use `fs.watch` on `~/.claude/teams/` for team changes. Parse process command lines for metadata: agent name, team name, parent session ID, model, cwd.

2. **Show external sessions in sidebar.** New sidebar group: "Running on this machine" (or integrated into the existing session list with a visual indicator). Each external session shows: agent name (or "standalone" + first prompt from history.jsonl), team membership, status (running/idle based on CPU usage or JSONL write recency), cwd/project.

3. **Team grouping automatic.** Sessions with the same team name are grouped. The augment-20260303 team shows as one group with 6 members listed. The orientation team shows as another group with 13 members. Standalone sessions are ungrouped.

4. **Read-only initially.** External sessions show status and metadata but are not interactive. Matt can see what's running, what team it belongs to, and whether it's active. He cannot type into external sessions from Augment (yet).

5. **Click to attach (Phase 1.5).** When Matt clicks an external session, Augment opens a new PTY that attaches to the same tmux pane where the session is running (the `tmuxPaneId` is in the team config). This gives full interactivity — the terminal output streams into Augment's xterm.js, and Matt can type. The session card transitions from "external/read-only" to "attached/interactive."

**Phase 2: Full interactivity**

- Attach to external sessions for full terminal interaction (requires tmux attach or equivalent)
- Attention detection on attached sessions (permission prompts, agent-finished signals)
- Cmd+J cycles through external sessions needing attention

**Phase 3: Remote sessions (Hetzner VPS)**

- SSH/Tailscale connection to VPS
- Discover CC processes on remote machine (same ps-based discovery over SSH)
- Remote session cards in sidebar with "remote" indicator
- Attach via SSH + tmux for interactivity

### Interaction with other features

**Session history/resume:** External sessions that finish should appear in the history (they're already in CC's JSONL storage — same data source). An external session that exits while Augment is watching transitions from "running" to "recent" in the sidebar. Resume works the same way — `claude --resume {sessionId}` in a new Augment PTY.

**Project grouping:** External sessions have `cwd` in their process args and team config. Group by cwd/project automatically. Matt's relay-plugin sessions group with relay, vault sessions group with vault.

**Attention queue:** Once sessions are attached (Phase 1.5), they participate in the attention queue. Until then, the sidebar card shows "external — running" or "external — idle" based on heuristics (CPU usage, JSONL write recency), but no attention detection (can't parse output without attachment).

### Data source recommendation

Use all three mechanisms in layers:

1. **Team configs (`~/.claude/teams/`)** — primary source for team sessions. `fs.watch` the directory. Read config.json for member roster, backend type, status. This gives structured data without polling.

2. **Process table** — secondary source for standalone sessions not in any team. Poll every 5-10s. Parse command-line args. Detect new/exited processes.

3. **Session JSONL** — tertiary source for session content (first prompt, duration, project). Read on demand when user expands a session card.

### Scope boundaries

- **Local first.** Remote discovery is Phase 3. Don't design for it now, but don't preclude it.
- **Read-only is acceptable for MVP.** Seeing what's running is 80% of the value. Full interactivity (attach) is Phase 1.5.
- **No process management.** Augment discovers and displays sessions. It does not kill, restart, or manage external CC processes. That's Matt's responsibility via the terminal where they're running.
- **Don't build a process monitor.** This is CC session discovery, not `htop`. Only show `claude` processes, not all processes. Only parse CC-specific metadata.

### What this makes Augment

The pitch line changes from "dispatch console for CC sessions" to "control plane for CC activity." Every CC session on the machine — manually started, team-spawned, background-automated — visible in one place. Status, team membership, project context, attention signals. This is the tool Matt described wanting: "I'd love it if [Augment] made those things available."

The Visionary part's framing from the earlier orientation applies: "not a terminal app but an attention router for agent sessions." Universal visibility completes that framing. The attention router can't route attention to sessions it doesn't know about.

### Stack context update (from vault stack part)

Matt's automation setup confirms the scale estimate:

**Current automation pipeline:** Google Meet → Drive → Apps Script → google-drive-fetch (polls 6 Drive folders, 5-min cycle) → watcher-dispatcher (watches 4 vault transcript folders, 5-min polling) → CC skill execution. All custom Python, no SaaS orchestration.

**Concurrency pattern:** 1-2 background agents + manual spawns. During orientation, 7+ parts simultaneously. No hardcoded limit.

**Remote/VPS:** Hetzner CX33 decided, not yet provisioned. Plan: migrate google-drive-fetch + watcher-dispatcher there as systemd services. CC sessions will run on VPS — Matt accesses via Tailscale.

**Scale verdict:** "Dashboard for 5-10 concurrent sessions across local + eventually remote." Will grow once VPS runs always-on automation. This confirms Phase 1 MVP scope is correct — local process discovery handles the immediate need. Remote comes after Hetzner provisioning.

**Apple Notes poller:** Not yet live, will add another automation trigger. More concurrent sessions in the future.

MVP doesn't need to handle 50+ sessions. 10-15 is the realistic ceiling for the next few months.

### Design convergence on universal visibility UX

Design proposed four decisions. Product assessment of each:

**1. No external badge — approved.** Design argues the external/internal distinction is an implementation detail, not a user-facing category. Correct. Unattached sessions show a neutral gray dot and "Running" status. After attach, they're identical to Augment-spawned sessions. The information gap (no granular status before attach) is a temporary state, not a category. No badge, no special treatment.

**2. Team collapse with "N more" — approved.** A 13-member team shows 3-4 top members (parent + attention-needing + active) with "10 more" toggle. Group header shows member count + summary status dot (yellow if attention, green if active, gray otherwise). This prevents large teams from consuming the sidebar. The sort order (attention → active → rest) ensures the most important members are always visible.

**3. Expand-then-attach — approved with one addition.** Click expands to show metadata + Attach/Ignore buttons. Consistent with session history's click-to-preview-then-resume pattern. The "Ignore" button is a good addition — with 18 sessions, dismissing noise is necessary. An "Ignored (3)" link at sidebar bottom lets Matt un-ignore.

**Product addition to the Ignore spec:** Ignored sessions resurface only on process exit (detectable from process table polling). Permission prompts in ignored sessions remain invisible — without attachment, no terminal output parsing. If Matt ignored a session, he accepted that tradeoff. The "Ignored (3)" link at sidebar bottom lets him reconsider.

### CTO technical feasibility — confirmed

CTO answered all technical questions. Summary of findings relevant to product:

**Session history:**
- `createSession()` extension with optional `cmd` parameter is the right approach for resume. Deterministic, no shell-state dependency.
- Reading 1,068 JSONL first-lines: <100ms total. Lazy-load on history panel open, not on boot.
- `fs.watch` on project directory + manual refresh fallback. No polling needed.
- Path hash is literal `path.replace(/\//g, '-')`. Augment can compute from known cwd.

**Universal visibility:**
- Team config `fs.watch` (primary) + process table polling every 10s (secondary) for discovery. Confirmed correct.
- Attach mechanism: `tmux capture-pane` for snapshot + `tmux pipe-pane` for ongoing stream, fed into read-only xterm.js. Medium effort. Input to external sessions via `tmux send-keys`. Viable.
- Status without attachment: team config `isActive` flag for team sessions, JSONL mtime for standalone. Process CPU is unreliable (I/O-bound). This gives us two-tier status: "active" vs. "idle" without attachment, full granularity after attachment.
- No CC API/IPC exists. Filesystem is the only external interface. Product's layering recommendation (team config → process table → JSONL) confirmed as correct architecture.

**One product implication from the attach assessment:** CTO describes attached external sessions as "viewable but not controllable" initially — input goes via `tmux send-keys` rather than direct PTY write. This means attached sessions have a slight interaction difference from Augment-spawned sessions. Design spec says attached sessions should be "indistinguishable" after attach. Product recommendation: accept `tmux send-keys` as the input mechanism — functionally equivalent from Matt's perspective (he types, text appears in the session). The implementation difference is invisible. If latency or reliability issues arise, revisit.

**4. Mixed list, no separate sections — approved.** Sessions group by team and project regardless of origin. Splitting a team across "Augment sessions" and "Other sessions" would fragment exactly the grouping the design was built to prevent. The user-facing categories are project and attention state, not spawn origin.
