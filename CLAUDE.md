# Augment

Augment is designed for high-speed, in-editor continuation while also providing a deep integrated terminal system for running agents like Claude Code.

## Parts system

This project has a persistent parts architecture at `.parts/`. See `.parts/PARTS.md` for the full project constitution, roster, and conventions.

To boot the project team from the vault, Matt says "Augment CEO" or "CEO augment" — this invokes the generic `project-ceo` skill which resolves the project, reads `.parts/PARTS.md`, and spawns domain parts using `project-*` vault skills parameterized with local `config.md` files.

@.parts/PARTS.md

## Project structure

- `src/` — TypeScript source (main.ts, terminal-view.ts, terminal-manager-view.ts, pty-bridge.ts, terminal-switcher.ts)
- `scripts/` — Build and utility scripts (terminal_pty.py, deploy.sh)
- `styles.css` — Plugin styling
- `.parts/` — Project parts (CEO, Product, Design, CTO, Visionary, Values)

## Installing Augment for a new user

`main.js` is pre-built and committed. **Do not run `npm install` or `npm run build`** — the plugin is ready to copy as-is.

Step 1 — copy the plugin files into the Obsidian vault:

```bash
mkdir -p "{vault}/.obsidian/plugins/augment/"
cp main.js manifest.json styles.css "{vault}/.obsidian/plugins/augment/"
```

Replace `{vault}` with the absolute path to the Obsidian vault.

**Finding the vault path on Windows/WSL:** the vault is typically at `/mnt/c/Users/{username}/Documents/Obsidian/{vault-name}` when accessed from WSL. Confirm the exact path in Obsidian → Settings → About → vault path, then prefix with `/mnt/c` and replace backslashes with forward slashes.

Step 2 — enable the plugin in Obsidian:

1. Open Obsidian → Settings → Community plugins
2. Disable safe mode if prompted
3. Find "Augment" in the list and enable it

Step 3 — configure:

1. Settings → Augment → Generate tab → paste the Anthropic API key
   - Get one at: https://platform.claude.com/settings/keys
2. Choose a model (Haiku 4.5 is fastest and cheapest)

## Modifying source

Only needed if changing the TypeScript source:

```bash
npm install
npm run build
```

Then copy as above.

## WSL terminal feature (Windows only)

To run Claude Code sessions inside Obsidian on Windows:

1. Settings → Augment → Terminal tab → the setup wizard walks through prerequisites
2. See `WSL.md` for manual setup details
