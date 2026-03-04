# Augment

Obsidian plugin for vault-aware AI text generation using Claude. Select text in any note, press Mod+Enter, get a completion that knows your note's title, frontmatter, and linked notes.

Also includes a terminal manager for running Claude Code sessions inside Obsidian (optional — AI generation works without it).

## Prerequisites

- Node.js 18+
- npm 8+
- Python 3.8+ (terminal manager only — not required for AI generation)
- macOS or Linux (Windows: see WSL.md)

## Build and install

```bash
npm install
npm run build
npm run obsidian:install   # copies main.js, styles.css, manifest.json to Obsidian plugin dir
```

The install path in `package.json` targets Matt's vault. For a different vault, edit the path in `scripts.obsidian:install`.

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
