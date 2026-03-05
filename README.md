# Augment

> **Beta.** Docs are AI-generated and rough. Use at your own risk.

Augment is designed for high-speed, in-editor continuation while also providing a deep integrated terminal system for running agents like Claude Code.

Press Mod+Enter in any note to generate inline — Augment uses your note's title, frontmatter, linked notes, and everything above your cursor as context. The terminal manager runs Claude Code sessions inside Obsidian alongside your notes.

## Prerequisites

- Node.js 18+
- npm 8+
- Python 3.8+ (terminal manager only — not required for AI generation)
- macOS or Linux (Windows: see WSL.md)

## Build and install

```bash
npm install
npm run build
```

Then copy the three plugin files into your Obsidian vault:

```bash
mkdir -p "{vault}/.obsidian/plugins/augment/"
cp main.js manifest.json styles.css "{vault}/.obsidian/plugins/augment/"
```

Replace `{vault}` with the absolute path to your Obsidian vault.

`main.js` is committed to the repo — if you don't want to build from source, skip `npm run build` and copy the files directly.

> `npm run obsidian:install` exists but is hardcoded to the maintainer's vault path. Use the manual copy above instead.

## Configure

1. Open Obsidian → Settings → Augment
2. Generate tab → API key → paste your Anthropic API key
   Get one at: https://platform.claude.com/settings/keys
3. Choose a model (Haiku 4.5 is fastest and cheapest)

## Verify

1. Open any note
2. Position cursor at end of a sentence
3. Press Mod+Enter (Cmd+Enter on Mac, Ctrl+Enter on Windows/Linux)
4. A generate prompt appears — enter a request and press Generate
5. Status bar shows "Augment: [model name]" when configured

## Windows / WSL

The terminal manager requires WSL on Windows. See WSL.md.
AI generation (Mod+Enter) works on Windows without WSL.

## Architecture

**AI generation path:** `src/main.ts` registers two editor commands. The generate command assembles vault context (`src/vault-context.ts`), calls the Anthropic API (`src/ai-client.ts`), and inserts output into the editor. While generating, a CM6 WidgetDecoration (`StateField`/`StateEffect`) inserts a triangle spinner widget at cursor position — no document text is modified until generation completes.

**Terminal manager:** `src/pty-bridge.ts` spawns `scripts/terminal_pty.py` as a child process. The Python bridge creates a pseudoterminal, forks a shell, and bridges I/O. fd 3 is the control channel: the plugin writes `R{rows},{cols}\n` to resize the PTY without mixing resize commands into the terminal data stream. On Windows with WSL mode enabled, the bridge is launched via `wsl python3 /mnt/c/...` — Node stdio pipes survive the WSL boundary as named pipe mappings.

**Output formats:** `outputFormat` setting controls how generated text is inserted — plain text, code block, blockquote, heading (with heading level), or callout (with callout type and expanded/collapsed state).
