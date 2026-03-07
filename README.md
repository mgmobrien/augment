# Augment

Run Claude Code terminal sessions and generate inline text within your notes using the Anthropic API.

Two surfaces:

- **Inline generation** — Press Cmd+Enter (Mac) or Ctrl+Enter (Windows/Linux) in any note. Augment sends your note's title, frontmatter, linked notes, and content above the cursor to the Anthropic API and inserts the response at cursor position.
- **Terminal manager** — Embedded terminal panes that run Claude Code sessions alongside your notes, with a Go PTY bridge handling shell I/O.

## Requirements

- Obsidian desktop (macOS or Linux; Windows is experimental)
- Anthropic API key — requires an [Anthropic account](https://console.anthropic.com/) and paid API usage
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed globally (`npm install -g @anthropic-ai/claude-code`) — for terminal features only

## Install

Download the latest release from the [releases page](https://github.com/mgmobrien/augment/releases):

1. Download `augment-{version}.zip`
2. Unzip and copy `main.js`, `manifest.json`, `styles.css`, and the `scripts/` folder into your vault at `.obsidian/plugins/augment-terminal/`
3. Open Obsidian → Settings → Community plugins → enable "Augment"
4. Settings → Augment → Overview tab → paste your Anthropic API key

## Terminal / Claude Code setup

Open Settings → Augment → Terminal tab. The setup wizard walks through four steps:

1. **Node.js** — [nodejs.org](https://nodejs.org) (LTS)
2. **Claude Code** — `npm install -g @anthropic-ai/claude-code`
3. **Sign in** — `claude auth login` (opens browser)
4. **Configure vault** — sets up CLAUDE.md and the skills folder

The wizard detects each step and shows the action button for the current step. Once all four rows show ✓, the terminal manager is ready.

## Precompiled binaries

The `scripts/` directory includes platform-specific Go binaries:

- `augment-pty-darwin-arm64`
- `augment-pty-linux-x64`
- `augment-pty-linux-arm64`
- `augment-pty-win32-x64.exe`

These binaries create a pseudoterminal (PTY), fork the configured shell, and bridge I/O over stdin/stdout. They are used only for the terminal manager — inline generation does not use them.

Source is open at [`cmd/augment-pty/`](cmd/augment-pty/) in this repository. To build from source:

```bash
GOOS=darwin GOARCH=arm64 go build -o scripts/augment-pty-darwin-arm64 ./cmd/augment-pty
```

## Data and privacy

Inline generation sends note content (title, frontmatter, linked notes, and text above the cursor) to the **Anthropic API**. No data is stored by this plugin beyond your local Obsidian vault. Anthropic's privacy policy: [anthropic.com/privacy](https://www.anthropic.com/privacy).

The terminal manager runs shell processes locally. No terminal output is sent to any external service by this plugin.

## Anthropic API key and billing

Inline generation requires an Anthropic API key. Keys are available at [console.anthropic.com](https://console.anthropic.com/) and require a paid account. Usage is billed by Anthropic per token. Haiku 4.5 is the fastest and lowest-cost model option.

## Modifying source

```bash
npm install
npm run build
```

To install into your vault during development:

```bash
export OBSIDIAN_VAULT_PATH="/path/to/your/vault"
npm run obsidian:install
```

## Architecture

**Inline generation:** `src/main.ts` registers editor commands. The generate command assembles vault context (`src/vault-context.ts`), calls the Anthropic API (`src/ai-client.ts`), and streams output into the editor. A CM6 `WidgetDecoration` inserts a spinner at cursor position during generation — no document text is modified until generation completes.

**Terminal manager:** `src/pty-bridge.ts` spawns the platform-specific Go binary. The binary creates a pseudoterminal, forks the configured shell, and bridges I/O over stdin/stdout. fd 3 is the control channel for resize events (`R{rows},{cols}\n`). macOS/Linux use `creack/pty`; Windows uses the native ConPTY API — no WSL required.
