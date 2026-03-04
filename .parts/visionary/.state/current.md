---
last_session: 2026-03-03
health: healthy
---

## Landscape summary (web scan 2026-03-03, updated re-orientation 2026-03-03)

Key players in agent-terminal-IDE space:
- **Warp Code** — agentic development environment. Built-in agent (Oz), interactive terminal agent capability.
- **Claude Code ecosystem** — native agent teams (experimental). CC Desktop (Electron). Third-party wrappers: opcode, CodePilot, Pilos Agents, Claude Code UI. All skins, none solve orchestration.
- **claude-squad** (smtg-ai) — tmux + git worktrees for multi-agent workspace isolation.
- **NTM** — Named Tmux Manager, TUI command palette for tiling agents.
- **Happy** — open-source mobile+web CC client. E2E encryption, bidirectional sync, voice coding.
- **Obsidian entries** — Obsidian-AI-CLI, Obsidian Vault Agent, Claude Sidebar. None have orchestration awareness.
- **VS Code 1.109** — "home for multi-agent development." First-class orchestration features in IDE.

## Active technology bets

1. **Attention-driven dispatch** — Augment's core differentiator. Three-zone layout with attention queue (waiting > error > idle-after-work). No competitor has this.
2. **Cross-surface session management** — coordination store models sessions/handoffs between Obsidian plugin and Electron app. Unique multi-surface architecture.
3. **Vault-context injection** — Obsidian integration advantage no standalone tool can replicate.
4. **Remote session management** — Hetzner VPS (replaces cancelled Mac Mini). Augment as control plane for remote agent fleet over Tailscale.

## Opportunities identified

- **Attention dispatch as product concept**: not "terminal app" but "attention router for agent sessions." Evidence: no competitor prioritizes by attention-need.
- **VPS as headless dispatch target**: Electron app as remote control plane for server-hosted CC sessions. Evidence: Hetzner VPS decided, coordination store workspace model exists.
- **Session migration between surfaces**: start in Obsidian (vault context), hand off to Electron (dispatch UX). Evidence: coordination store handoff protocol implemented (unwired).
- **CC hooks replacing regex parsing**: PostToolUse hooks could emit structured events, eliminating regex fragility. Evidence: CC hook system exists, not yet tested for this purpose.

## Trajectory assessment

- Agent session management consolidating as product category (6-month trend)
- GUI wrapper market for CC is commodity — don't compete here
- Attention-driven dispatch is a novel interaction pattern absent from competitors
- Cross-surface handoff is architecturally unique — no competitor spans host environments
- IDE vendors absorbing orchestration — compression risk if user fits one IDE (Matt doesn't)
- Mobile agent access via VPS + Tailscale (Hetzner replaces Mac Mini, same workflow pattern)

## Risks tracked

- CC output format instability (regex parsing fragility, duplicated across both surfaces)
- Anthropic ships CC Desktop with attention management (6-12 month window)
- Two-surface maintenance burden (independent implementations, drift is certain)
- Obsidian-only distribution ceiling (partially addressed by standalone Electron)
