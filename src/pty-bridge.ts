import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { Writable } from "stream";

export class PtyBridge {
  private process: ChildProcess | null = null;
  private controlStream: Writable | null = null;
  private pluginDir: string;

  constructor(
    pluginDir: string,
    private cwd: string,
    private onData: (data: string) => void,
    private onExit: (code: number) => void
  ) {
    this.pluginDir = pluginDir;
  }

  start(): void {
    const ptyScript = join(this.pluginDir, "scripts", "terminal_pty.py");

    this.process = spawn("python3", [ptyScript], {
      cwd: this.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        LANG: process.env.LANG || "en_US.UTF-8",
      },
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
