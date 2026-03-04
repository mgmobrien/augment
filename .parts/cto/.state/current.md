---
last_session: 2026-03-03
health: green
---

## Architecture map

Two surfaces, separate codebases, shared PTY bridge:

- **Obsidian plugin** (`src/`): 6 modules (~1,400 lines). `main.ts` → `terminal-view.ts` → `pty-bridge.ts` → `terminal_pty.py`. Manager view, switcher modal, coordination store (unused).
- **Electron app** (`electron/`): `main.cjs` (IPC/process mgmt) → `renderer.ts` (1,336 lines, all UI + logic) → `terminal_pty.py` via IPC. `index.html` has CSS + layout.
- **Shared**: `scripts/terminal_pty.py` (Python PTY bridge, fd 3 control channel), xterm.js dependency stack.

Key boundary: Obsidian plugin uses Obsidian API (`ItemView`, workspace events, leaf state persistence). Electron app uses IPC (`ipcMain`/`ipcRenderer` via preload). No shared TypeScript modules between surfaces.

## Dependencies

- @xterm/xterm ^5.5.0, @xterm/addon-fit ^0.10.0, @xterm/addon-serialize ^0.13.0, @xterm/addon-web-links ^0.11.0
- electron ^40.6.1, electron-builder ^26.8.1
- typescript ^5.4.0, esbuild ^0.21.0
- obsidian: latest (dev only)

## Known technical debt

1. **Code duplication (medium):** ~300 lines duplicated between `terminal-view.ts` and `renderer.ts` — status detection, orchestration parsing, ANSI stripping, name generation.
2. **Electron renderer monolith (low):** 1,336 lines in one file. Split if more features land.
3. **Coordination store unused (low):** 250 lines imported by nothing.
4. **Broad permission detection regex (low):** False-positive "waiting" status from normal Claude output.

## Recent architectural decisions

- Electron app implemented as a standalone reimplementation rather than extracting shared modules from the Obsidian plugin. Acceptable for speed at prototype stage. Creates duplication debt.
- Coordination store uses filesystem JSON at `~/.augment/workspaces/` with SHA-1 workspace IDs. Not yet connected to either surface.
- Both builds pass (esbuild for plugin, separate esbuild for electron). No CI.
