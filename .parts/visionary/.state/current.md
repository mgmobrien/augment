---
last_session: 2026-03-03
health: healthy
---

## Landscape summary (web scan 2026-03-03)

Key players in agent-terminal-IDE space:
- **Warp Code** — pivoted to "agentic development environment." Built-in agent (Oz), file editor, code review, Slack/Linear/GitHub integrations. Interactive terminal agent capability (debuggers, DB shells).
- **Claude Code ecosystem** — native agent teams (experimental, tmux/in-process). CC Desktop (Electron). Third-party wrappers: opcode (Tauri), CodePilot (Electron+Next.js), Pilos Agents, Claude Code UI (web/mobile). All skins, none solve orchestration.
- **claude-squad** (smtg-ai) — tmux + git worktrees for multi-agent workspace isolation. Terminal-native.
- **NTM** — Named Tmux Manager, TUI command palette for tiling agents.
- **Happy** — open-source mobile+web CC client. E2E encryption (TweetNaCl), bidirectional sync, voice coding. iOS/Android/web.
- **Obsidian entries** — Obsidian-AI-CLI, Obsidian Vault Agent, Claude Sidebar. None have orchestration awareness.
- **VS Code 1.109** — "home for multi-agent development." First-class orchestration features in IDE.

## Active technology bets

1. **Orchestration-aware session management** — Augment's differentiator. Parsing CC output for team events. Fragile (regex-based) but novel.
2. **Vault-context injection** — Obsidian integration advantage no standalone tool can replicate.
3. **Remote session management** — Mac Mini arriving Mar 4. Augment as control plane for distributed agent fleet over Tailscale/SSH.

## Opportunities identified

- **Deepen orchestration**: richer agent state (current tool, elapsed time, last message), team topology viz, bidirectional control from manager panel. Evidence: no competitor does this.
- **Mac Mini bridge**: manage remote CC sessions. No competitor has agent fleet management across local + remote. Evidence: Matt ordered hardware, Happy proves mobile relay pattern works.
- **Vault-context sessions**: "start CC with context from these vault notes." Evidence: Augment is the only terminal tool running inside Obsidian.

## Trajectory assessment

- Agent session management is consolidating as a product category (6-month trend)
- GUI wrapper market for CC is crowded and commodity — don't compete here
- Terminal-native tools cap out at rich state visualization — Augment fills the gap
- IDE vendors absorbing orchestration — compression risk if user fits one IDE (Matt doesn't)
- Mobile agent access emerging — Happy proves the pattern, Mac Mini makes it imminent

## Risks tracked

- CC output format instability (regex parsing fragility)
- Anthropic ships native agent session management in CC Desktop (6-12 month window)
- Obsidian-only distribution ceiling
