import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { copyFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { Writable } from "stream";

export interface PtyBridgeOptions {
  pluginDir: string;
  cwd: string;
  shellPath?: string;
  onData: (data: string) => void;
  onExit: (code: number) => void;
  onError?: (err: Error) => void;
}

// macOS may SIGKILL binaries executed from certain paths (vault dirs, iCloud-
// synced folders, etc.). Copy the binary to a temp location before spawning.
const STAGING_DIR = join(tmpdir(), "augment-pty");

function stageBinary(sourcePath: string, binaryName: string): string {
  if (!existsSync(STAGING_DIR)) mkdirSync(STAGING_DIR, { recursive: true });
  const staged = join(STAGING_DIR, binaryName);
  // Re-copy if source is newer or staged copy doesn't exist.
  let needsCopy = !existsSync(staged);
  if (!needsCopy) {
    try {
      const { statSync } = require("fs");
      needsCopy = statSync(sourcePath).mtimeMs > statSync(staged).mtimeMs;
    } catch { needsCopy = true; }
  }
  if (needsCopy) {
    copyFileSync(sourcePath, staged);
    chmodSync(staged, 0o755);
  }
  return staged;
}

export class PtyBridge {
  private process: ChildProcess | null = null;
  private controlStream: Writable | null = null;
  private pluginDir: string;
  private cwd: string;
  private shellPath: string;
  private onData: (data: string) => void;
  private onExit: (code: number) => void;
  private onError?: (err: Error) => void;

  constructor(opts: PtyBridgeOptions) {
    this.pluginDir = opts.pluginDir;
    this.cwd = opts.cwd;
    this.shellPath = opts.shellPath || "";
    this.onData = opts.onData;
    this.onExit = opts.onExit;
    this.onError = opts.onError;
  }

  start(): void {
    const platform = process.platform;
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const binaryName = `augment-pty-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
    const sourcePath = join(this.pluginDir, "scripts", binaryName);
    const binaryPath = stageBinary(sourcePath, binaryName);

    const env: Record<string, string | undefined> = {
      ...process.env,
      TERM: "xterm-256color",
      LANG: process.env.LANG || "en_US.UTF-8",
      AUGMENT_SHELL: this.shellPath || process.env.SHELL || (platform === "win32" ? "cmd.exe" : "bash"),
      AUGMENT_CWD: this.cwd,
    };

    this.process = spawn(binaryPath, [], {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });

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
      this.onError?.(err);
      this.process = null;
      this.controlStream = null;
      this.onExit(1);
    });
  }

  write(data: string): void {
    this.process?.stdin?.write(data);
  }

  resize(rows: number, cols: number): void {
    this.controlStream?.write(`R${rows},${cols}\n`);
  }

  kill(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}
