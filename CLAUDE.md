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

### Option A: build from source

```bash
npm install
npm run build
```

### Option B: use pre-built files

`main.js` is committed to the repo. If you don't want to build, skip straight to the copy step below.

### Copy plugin files into Obsidian

Create the plugin directory and copy the three required files:

```bash
mkdir -p "{vault}/.obsidian/plugins/augment/"
cp main.js manifest.json styles.css "{vault}/.obsidian/plugins/augment/"
```

Replace `{vault}` with the absolute path to your Obsidian vault.

**Finding your vault path on WSL/Windows:** Obsidian vaults on Windows are typically at `/mnt/c/Users/{username}/Documents/Obsidian/{vault-name}` when accessed from WSL — but check your actual Obsidian vault location (Obsidian → Settings → About → Vault path).

### Enable the plugin in Obsidian

1. Open Obsidian → Settings → Community plugins
2. Disable safe mode if prompted
3. Find "Augment" in the list and enable it

### Required setup

1. Settings → Augment → Generate tab → paste your Anthropic API key
   - Get one at: https://platform.claude.com/settings/keys
2. Choose a model (Haiku 4.5 is fastest and cheapest)

### WSL terminal feature (Windows only)

To run Claude Code sessions inside Obsidian on Windows:

1. Settings → Augment → Generate tab → enable "Run terminal via WSL"
2. See `WSL.md` for Python prerequisites and setup details
