# Augment

> **Beta.** Docs are AI-generated and rough. Use at your own risk.

Augment is designed for high-speed, in-editor continuation while also providing a deep integrated terminal system for running agents like Claude Code.

Press Mod+Enter in any note to generate inline — Augment uses your note's title, frontmatter, linked notes, and everything above your cursor as context. The terminal manager runs Claude Code sessions inside Obsidian alongside your notes.

## Install

`main.js` is committed to the repo — no build required.

```bash
mkdir -p "{vault}/.obsidian/plugins/augment/"
cp main.js manifest.json styles.css "{vault}/.obsidian/plugins/augment/"
```

Replace `{vault}` with the absolute path to your Obsidian vault.

**Windows with WSL:** your vault is typically at `/mnt/c/Users/{username}/Documents/Obsidian/{vault-name}/`. Find the exact path in Obsidian: Settings → General → vault path — then prefix with `/mnt/c` and replace backslashes with forward slashes.

### Build from source

```bash
npm install
npm run build
```

Then copy as above.

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
4. A spinner appears at the cursor while generating; output is inserted inline when complete
5. Status bar shows "Augment: [model name]" when configured

## Terminal / Claude Code setup

Open Settings → Augment → Terminal tab. The setup wizard detects your environment and walks through each prerequisite:

- **macOS/Linux:** Python 3, Node.js, Claude Code, CC authentication
- **Windows:** WSL, then Python/Node/CC inside WSL

The wizard shows only the next missing step and advances as each is resolved. Once everything is green, the terminal manager is ready. See WSL.md for manual Windows setup.

## Architecture

**AI generation path:** `src/main.ts` registers two editor commands. The generate command assembles vault context (`src/vault-context.ts`), calls the Anthropic API (`src/ai-client.ts`), and inserts output into the editor. While generating, a CM6 WidgetDecoration (`StateField`/`StateEffect`) inserts a triangle spinner widget at cursor position — no document text is modified until generation completes.

**Terminal manager:** `src/pty-bridge.ts` spawns `scripts/terminal_pty.py` as a child process. The Python bridge creates a pseudoterminal, forks a shell, and bridges I/O. fd 3 is the control channel: the plugin writes `R{rows},{cols}\n` to resize the PTY without mixing resize commands into the terminal data stream. On Windows with WSL mode enabled, the bridge is launched via `wsl python3 /mnt/c/...` — Node stdio pipes survive the WSL boundary as named pipe mappings.

**Output formats:** `outputFormat` setting controls how generated text is inserted — plain text, code block, blockquote, heading (with heading level), or callout (with callout type and expanded/collapsed state).
