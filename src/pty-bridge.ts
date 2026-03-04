import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { Writable } from "stream";

/**
 * Convert a Windows absolute path (e.g. C:\Users\...) to the WSL mount path
 * (e.g. /mnt/c/Users/...). Used when spawning the PTY bridge via `wsl python3`.
 *
 * This handles the common case where the drive letter maps to /mnt/<drive>.
 * If your WSL distro uses a custom mount point (set in /etc/wsl.conf), adjust
 * the replacement prefix accordingly.
 */
function toWslPath(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
    .replace(/\\/g, "/");
}

export class PtyBridge {
  private process: ChildProcess | null = null;
  private controlStream: Writable | null = null;
  private pluginDir: string;

  constructor(
    pluginDir: string,
    private cwd: string,
    private useWsl: boolean,
    private onData: (data: string) => void,
    private onExit: (code: number) => void
  ) {
    this.pluginDir = pluginDir;
  }

  start(): void {
    // terminal_pty.py is the PTY bridge script. It:
    //   1. Forks a shell inside a Unix pseudoterminal (pty.openpty())
    //   2. Bridges stdin/stdout between Node and the PTY master fd
    //   3. Listens on fd 3 (the control channel) for resize commands:
    //      "R{rows},{cols}\n" — forwarded here via PtyBridge.resize()
    //
    // Python's `pty` module is Unix-only (uses os.fork + fcntl + TIOCSWINSZ).
    // It will not run under native Windows Python. On Windows, Angus needs WSL.
    const ptyScript = join(this.pluginDir, "scripts", "terminal_pty.py");

    // Spawn command routing:
    //
    // macOS / Linux (default): spawn python3 directly.
    //
    // Windows + useWsl=true: spawn via `wsl python3 <linux-path>`.
    //   - `wsl` is the WSL launcher installed with Windows Subsystem for Linux.
    //   - The Python script path is converted from Windows format (C:\...) to
    //     the WSL mount format (/mnt/c/...) so the Linux process can find it.
    //   - stdin, stdout, stderr, and fd 3 are all Windows named pipes that WSL
    //     maps transparently to file descriptors inside the Linux process.
    //     fd 3 (the control channel) should be inherited normally — the Python
    //     script opens it with os.fstat(3) and it works the same as on native Linux.
    //
    // Assumptions for WSL mode:
    //   - `wsl` is on the Windows PATH (usually at C:\Windows\System32\wsl.exe)
    //   - python3 is installed in the default WSL distro (run `wsl python3 --version`)
    //   - The Obsidian vault/plugin is on a drive mounted under /mnt/ (the default)
    //   - If your WSL distro uses a custom mountRoot in /etc/wsl.conf, update toWslPath()
    //
    // To pick a specific distro: change "wsl" to "wsl" with args ["-d", "Ubuntu", "python3", ...]
    let cmd: string;
    let args: string[];
    if (this.useWsl && process.platform === "win32") {
      // Route through WSL: convert Windows path to Linux mount path
      const wslScript = toWslPath(ptyScript);
      cmd = "wsl";
      args = ["python3", wslScript];
    } else {
      cmd = "python3";
      args = [ptyScript];
    }

    this.process = spawn(cmd, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        LANG: process.env.LANG || "en_US.UTF-8",
      },
      // stdio tuple: [stdin, stdout, stderr, fd-3-control-channel]
      // fd 3 is a writable pipe that carries out-of-band control messages
      // (resize commands) without polluting the terminal data stream.
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });

    // fd 3 is the control channel for resize commands
    this.controlStream = this.process.stdio[3] as Writable;

    this.process.stdout?.setEncoding("utf-8");
    this.process.stdout?.on("data", (data: string) => {
      this.onData(data);
    });

    this.process.stderr?.setEncoding("utf-8");
    this.process.stderr?.on("data", (data: string) => {
      console.error("[augment-pty]", data);
    });

    this.process.on("exit", (code) => {
      this.process = null;
      this.controlStream = null;
      this.onExit(code ?? 0);
    });

    this.process.on("error", (err) => {
      console.error("[augment-pty] Process error:", err);
      this.process = null;
      this.controlStream = null;
      this.onExit(1);
    });
  }

  write(data: string): void {
    this.process?.stdin?.write(data);
  }

  resize(rows: number, cols: number): void {
    // Send resize command on the control channel (fd 3)
    this.controlStream?.write(`R${rows},${cols}\n`);
  }

  kill(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      // Don't null references here — let the exit handler do cleanup
      // so onExit callback fires properly
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}
