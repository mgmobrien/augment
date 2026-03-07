# Augment

> **Beta.** Docs are AI-generated and rough. Use at your own risk.

Augment is designed for high-speed, in-editor continuation while also providing a deep integrated terminal system for running agents like Claude Code.

Press Cmd+Enter (Mac) or Ctrl+Enter (Windows/Linux) in any note to generate inline — Augment uses your note's title, frontmatter, linked notes, and everything above your cursor as context. The terminal manager runs Claude Code sessions inside Obsidian alongside your notes.

## Install

`main.js` is pre-built and committed. **Do not run `npm install` or `npm run build`** — the plugin is ready to copy as-is.

```bash
mkdir -p "{vault}/.obsidian/plugins/augment/"
cp main.js manifest.json styles.css "{vault}/.obsidian/plugins/augment/"
```

Replace `{vault}` with the absolute path to your Obsidian vault.

After copying:

1. Open Obsidian → Settings → Community plugins → enable "Augment"
2. Settings → Augment → Overview tab → paste your Anthropic API key (https://platform.claude.com/settings/keys)
3. Choose a model (Haiku 4.5 is fastest and cheapest)

## Verify

1. Open any note
2. Position cursor at end of a sentence
3. Press Cmd+Enter on Mac, or Ctrl+Enter on Windows/Linux
4. A spinner appears at the cursor while generating; output is inserted inline when complete
5. Status bar shows "Augment: [model name]" when configured

## Terminal / Claude Code setup

Open Settings → Augment → Terminal tab. The setup wizard walks through four steps — same on every platform:

1. **Node.js** — [nodejs.org](https://nodejs.org) (LTS)
2. **Claude Code** — `npm install -g @anthropic-ai/claude-code`
3. **Sign in** — `claude auth login` (opens browser)
4. **Configure vault** — sets up CLAUDE.md and the skills folder

The wizard detects each step automatically and shows the action button for the current step. Once all four rows show ✓, the terminal manager is ready.

## Updating

Download the latest zip from the [releases page](https://github.com/mgmobrien/augment/releases):

1. Download `augment-{version}.zip`
2. Extract `main.js`, `manifest.json`, `styles.css` into your vault at `.obsidian/plugins/augment-terminal/`
3. In Obsidian: Settings → Community plugins → toggle Augment off and back on

**macOS/Linux (if cloned):**

```bash
git pull && bash scripts/deploy.sh
```

## Modifying source

Only needed if you are changing the TypeScript source:

```bash
npm install
npm run build
```

To install directly into your vault during development, set `OBSIDIAN_VAULT_PATH` to your vault root, then run:

```bash
export OBSIDIAN_VAULT_PATH="/path/to/your/vault"
npm run obsidian:install
```

Then copy as above.

## Architecture

**AI generation path:** `src/main.ts` registers two editor commands. The generate command assembles vault context (`src/vault-context.ts`), calls the Anthropic API (`src/ai-client.ts`), and inserts output into the editor. While generating, a CM6 WidgetDecoration (`StateField`/`StateEffect`) inserts a triangle spinner widget at cursor position — no document text is modified until generation completes.

**Terminal manager:** `src/pty-bridge.ts` spawns a platform-specific Go binary from `scripts/` (`augment-pty-darwin-arm64`, `augment-pty-linux-x64`, `augment-pty-linux-arm64`, or `augment-pty-win32-x64.exe`). The binary creates a pseudoterminal, forks the configured shell, and bridges I/O over stdin/stdout. fd 3 is the control channel: the plugin writes `R{rows},{cols}\n` to resize the PTY without mixing resize commands into the terminal data stream. On Mac and Linux the binary uses `creack/pty`; on Windows it uses the native ConPTY API (`UserExistsError/conpty`) — no WSL required. Go source lives in `cmd/augment-pty/`.

**Output formats:** `outputFormat` setting controls how generated text is inserted — plain text, code block, blockquote, heading (with heading level), or callout (with callout type and expanded/collapsed state).
