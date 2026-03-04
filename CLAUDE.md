# Augment

Standalone Electron app (and Obsidian plugin) for running and managing Claude Code terminal sessions. Built by Matt O'Brien (System 3). Prototype stage, personal use.

## Parts system

This project has a persistent parts architecture at `.parts/`. See `.parts/PARTS.md` for the full project constitution, roster, and conventions.

To boot the project team from the vault, Matt says "Augment CEO" or "CEO augment" — this invokes the generic `project-ceo` skill which resolves the project, reads `.parts/PARTS.md`, and spawns domain parts using `project-*` vault skills parameterized with local `config.md` files.

@.parts/PARTS.md

## Project structure

- `src/` — TypeScript source (main.ts, terminal-view.ts, terminal-manager-view.ts, pty-bridge.ts, terminal-switcher.ts)
- `scripts/` — Build and utility scripts (terminal_pty.py, deploy.sh)
- `styles.css` — Plugin styling
- `.parts/` — Project parts (CEO, Product, Design, CTO, Visionary, Values)
