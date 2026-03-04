# Running Augment on Windows via WSL

## The setup this is designed for

Obsidian runs on Windows. Claude Code runs inside WSL (not on Windows natively). The Augment terminal is how you get Claude Code sessions inside Obsidian — each terminal tab is a WSL Linux session with Claude Code running in it.

The PTY bridge (`scripts/terminal_pty.py`) is what makes the terminal work. It spawns a shell inside a pseudoterminal and bridges I/O between Obsidian and the shell process. Python's `pty` module is Unix-only — it uses `os.fork()`, `fcntl`, and `TIOCSWINSZ` ioctls that don't exist on Windows. The bridge has to run inside WSL.

## Enabling it

In Obsidian: **Settings → Augment → Generate tab → Run terminal via WSL** (toggle on).

The toggle only appears on Windows (`process.platform === 'win32'`).

## How the spawn works

When WSL mode is enabled, the plugin (running in Obsidian on Windows) spawns:

```
wsl python3 /mnt/c/Users/.../terminal_pty.py
```

instead of:

```
python3 C:\Users\...\terminal_pty.py
```

The Windows path is converted to the WSL mount path automatically:
`C:\path\to\file.py` → `/mnt/c/path/to/file.py`

Node's `child_process.spawn` opens four stdio pipes (stdin, stdout, stderr, fd 3). WSL maps these Windows named pipes to file descriptors inside the Linux process. The Python script sees them as ordinary Unix fds.

The shell the bridge spawns is your WSL default shell (`$SHELL` or `/bin/zsh`). That's the Linux shell where you run `claude`. You're fully inside WSL from that point.

## What fd 3 is

fd 3 is the **control channel** — a separate pipe used to send resize commands without mixing them into terminal data. When you resize the Obsidian pane, the plugin writes `R{rows},{cols}\n` to fd 3. The Python script reads it and calls `TIOCSWINSZ` on the PTY master to update terminal dimensions, then sends `SIGWINCH` to the shell process.

This is why a plain `spawn("wsl", ["python3", script])` without `stdio: ["pipe","pipe","pipe","pipe"]` won't work — fd 3 must be explicitly piped.

## Prerequisites

1. **WSL installed** — run `wsl --status` in PowerShell. If not installed: `wsl --install`.
2. **python3 in your default distro** — run `wsl python3 --version`. If missing: `wsl sudo apt install python3`.
3. **Claude Code in your WSL distro** — see "Installing Claude Code" below.
4. **`wsl` on the Windows PATH** — it lives at `C:\Windows\System32\wsl.exe`, always in PATH on modern Windows.

## What you may need to adjust

**Custom WSL mount point.** By default WSL mounts drives at `/mnt/c`, `/mnt/d`, etc. If your `/etc/wsl.conf` sets a custom `mountRoot`, the auto-converted path will be wrong. Edit `toWslPath()` in `src/pty-bridge.ts`:

```typescript
// Default (no changes needed):
.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)

// Custom mountRoot = /wsl:
.replace(/^([A-Za-z]):/, (_, drive) => `/wsl/${drive.toLowerCase()}`)
```

**Specific WSL distro.** The plugin spawns `wsl python3 ...` which uses your default distro. To target a specific one, edit the spawn args in `src/pty-bridge.ts`:

```typescript
// Before:
args = ["python3", wslScript];

// After (targets Ubuntu specifically):
args = ["-d", "Ubuntu", "python3", wslScript];
```

**LANG / locale.** If you see garbled output, check that your WSL distro has `en_US.UTF-8` locale installed: `wsl locale -a | grep UTF`.

## Accessing your vault from WSL

Obsidian stores the vault on the Windows filesystem. From inside WSL, the vault is at:

```
/mnt/c/Users/<you>/path/to/your/vault
```

When you run `claude` from the Augment terminal, you'll want to `cd` to the vault path so Claude Code has the right working directory. Example:

```bash
cd /mnt/c/Users/Angus/Documents/ObsidianVault
claude
```

You can add this as an alias in your WSL `~/.bashrc` or `~/.zshrc` to avoid typing it every time.

## What a working terminal looks like

After enabling WSL mode and opening a new terminal tab (close and reopen any existing tab):

1. The terminal opens and shows a Linux shell prompt (bash or zsh).
2. `uname -a` returns a Linux kernel string.
3. `python3 --version` works.
4. Resizing the Obsidian pane updates terminal width (`echo $COLUMNS` reflects the new size).
5. `claude` launches Claude Code.

## Installing Claude Code in WSL

```bash
# Inside the WSL terminal (or run from PowerShell with `wsl -- ...`):
curl -fsSL https://fnm.vercel.app/install | bash   # install fnm (node version manager)
source ~/.bashrc
fnm install --lts
fnm use lts-latest
npm install -g @anthropic-ai/claude-code
claude
```

Or if you already have Node.js in WSL:

```bash
npm install -g @anthropic-ai/claude-code
claude
```
