---
last_session: 2026-03-03-orientation
health: active
---

## Current interaction patterns

- Electron dispatch console: 3-zone layout (sidebar | focus | context), keyboard-first (9 shortcuts), attention queue with Cmd+J
- Obsidian plugin: terminal tabs with status dots, manager sidebar, fuzzy switcher
- Session switching: sequential (Cmd+Shift+[/]), indexed (Cmd+1-9), attention-driven (Cmd+J)
- Rename: inline input via double-click or Cmd+E
- Context pane: peripheral awareness with status, preview, team member chips

## Active design concerns

- Missing "waiting" status on Obsidian surface — attention gap
- Attention signal lost when sidebar collapsed in Electron
- No keyboard shortcut discoverability surface
- Status dot color semantics differ between surfaces (shell, idle)
- ANSI stripping divergence affects status detection reliability
- Context pane preview text (10px) is borderline legible
- Member chip navigation fails silently when target session not yet parsed

## Design decisions made

(None yet — cold boot)

## UX debt

- Port "waiting" status detection to Obsidian terminal-view.ts
- Add persistent attention indicator that survives sidebar collapse
- Add keyboard shortcut overlay (Cmd+/ or Cmd+?)
- Normalize ANSI stripping into shared module
- Add feedback toast on failed member-chip navigation
- Reconcile status dot color mapping across surfaces
