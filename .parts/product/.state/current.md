---
last_session: 2026-03-03
health: initialized
---

## Feature inventory

- **Obsidian plugin:** 8 commands (open, split-v, split-h, grid, sidebar, rename, manager, switcher). Terminal tabs via xterm.js + Python PTY bridge. Status detection (shell/active/tool/idle/exited). Orchestration parsing (TeamCreate, SendMessage). Terminal manager sidebar. Feature-complete for plugin surface.
- **Electron dispatch console:** Three-zone layout (sidebar, focus terminal, context pane). Attention queue with priority sorting (waiting > error > idle-after-work). Keyboard shortcuts (Cmd+T/W/J/B/\/E/Shift+[]/1-9). Status detection (adds "waiting" and "error" states beyond plugin). Orchestration parsing ported. Session rename. Slide animation on switch. This is the active development front.
- **Coordination store:** Cross-surface session tracking and handoff records. JSON at `~/.augment/workspaces/`. Not wired to any UI.

## Roadmap items

- Tighten Electron dispatch experience (validate attention detection reliability, iterate on keyboard flow)
- Investigate CC hooks as alternative to regex-based status detection
- Decide whether coordination store is worth wiring up (depends on whether Matt uses both surfaces)
- Session persistence in Electron (closing kills all sessions — potential pain point)

## Scope decisions

- Stage: Level 1, personal use. Matt is sole user. No optimization for hypothetical users.
- Electron app is focus surface. Plugin is stable, not actively developed.
- Coordination store: hold until cross-surface use case is confirmed.

## Product assessment

Core value proposition: attention dispatch for agent sessions. The attention queue + Cmd+J triage cycle is the interaction that differentiates Augment from tmux or other terminal multiplexers. Status detection reliability (especially false positives from broad permission regex) is the main risk to that value.
