# Running Augment on Windows via WSL

## What this is

The Augment terminal uses a Python PTY bridge (`scripts/terminal_pty.py`) to spawn a shell inside a pseudoterminal. Python's `pty` module is Unix-only — it uses `os.fork()`, `fcntl`, and `TIOCSWINSZ` ioctls that don't exist on Windows. Native Windows Python will fail immediately.

If you're running Obsidian on Windows with WSL installed, you can route the PTY bridge through WSL. This runs the Python script inside the Linux environment, which has full pty support, while Obsidian and the plugin continue running on the Windows side.

## Enabling it

In Obsidian: **Settings → Augment → Generate tab → Run terminal via WSL** (toggle on).

The toggle only appears on Windows (`process.platform === 'win32'`). On macOS/Linux it has no effect.

## How the spawn works

When WSL mode is enabled, the plugin spawns:

```
wsl python3 /mnt/c/Users/.../terminal_pty.py
```

instead of:

```
python3 C:\Users\...\terminal_pty.py
```

The Windows path is converted to the WSL mount path automatically:
`C:\path\to\file.py` → `/mnt/c/path/to/file.py`

Node's `child_process.spawn` opens four stdio pipes (stdin, stdout, stderr, fd 3). WSL maps these Windows named pipes to file descriptors inside the Linux process. The Python script sees them as ordinary Unix fds and `os.fstat(3)` succeeds on the control channel.

## What fd 3 is

fd 3 is the **control channel** — a separate pipe used to send resize commands without mixing them into terminal data. When you resize the Obsidian pane, the plugin writes `R{rows},{cols}\n` to fd 3. The Python script reads it and calls `TIOCSWINSZ` on the PTY master to update the terminal dimensions, then sends `SIGWINCH` to the shell process.

This is why a plain `spawn("wsl", ["python3", script])` without `stdio: ["pipe","pipe","pipe","pipe"]` won't work — fd 3 must be explicitly piped.

## Prerequisites

1. **WSL installed** — run `wsl --status` in PowerShell. If not installed: `wsl --install`.
2. **python3 in your default distro** — run `wsl python3 --version`. If missing: `wsl sudo apt install python3`.
3. **`wsl` on the PATH** — it lives at `C:\Windows\System32\wsl.exe` which is always in PATH on modern Windows.

## What you may need to adjust

**Custom WSL mount point.** By default WSL mounts drives at `/mnt/c`, `/mnt/d`, etc. If your `/etc/wsl.conf` sets a custom `mountRoot`, the auto-converted path will be wrong. Edit `toWslPath()` in `src/pty-bridge.ts` to match your setup:

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

**Shell inside WSL.** The Python bridge spawns `$SHELL` or `/bin/zsh` inside the Linux environment. You'll get a Linux shell (bash/zsh), not PowerShell or cmd. This is expected — the whole point is running inside WSL's Linux environment.

**LANG / locale.** If you see garbled output, check that your WSL distro has `en_US.UTF-8` locale installed: `wsl locale -a | grep UTF`.

## What a working terminal looks like

After enabling WSL mode and restarting a terminal tab (close and reopen):

1. The terminal opens and you see a Linux shell prompt (bash or zsh).
2. `uname -a` returns a Linux kernel string.
3. `python3 --version` works.
4. Resizing the Obsidian pane updates the terminal width (`echo $COLUMNS` reflects the new size).
5. `claude` (Claude Code) launches if installed in the WSL distro.

## Installing Claude Code in WSL

```bash
# Inside the WSL terminal:
npm install -g @anthropic-ai/claude-code
claude
```

Your vault is accessible from WSL at `/mnt/c/Users/<you>/path/to/vault` (or wherever Obsidian keeps it on Windows).
