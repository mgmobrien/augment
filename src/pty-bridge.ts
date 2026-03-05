import { spawn, ChildProcess, execFileSync } from "child_process";
import { join } from "path";
import { copyFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { Writable } from "stream";

export interface PtyBridgeOptions {
  pluginDir: string;
  cwd: string;
  shellPath?: string;
  onData: (data: string) => void;
  onExit: (code: number, signal?: NodeJS.Signals | null) => void;
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
      // Use >= so a freshly copied plugin binary with equal mtime still refreshes
      // the staged executable after app reload (avoids stale bridge binaries).
      needsCopy = statSync(sourcePath).mtimeMs >= statSync(staged).mtimeMs;
    } catch { needsCopy = true; }
  }
  if (needsCopy) {
    copyFileSync(sourcePath, staged);
    chmodSync(staged, 0o755);
    // Best effort: refresh ad-hoc signature on staged copy.
    // Some macOS setups reject copied executables from temp paths unless re-signed.
    if (process.platform === "darwin") {
      try {
        execFileSync("codesign", ["-s", "-", "-f", staged], { stdio: "ignore" });
      } catch {
        // Fall through; direct-path candidate may still work.
      }
    }
  }
  return staged;
}

export class PtyBridge {
  private process: ChildProcess | null = null;
  private controlStream: Writable | null = null;
  private stopping = false;
  private pluginDir: string;
  private cwd: string;
  private shellPath: string;
  private onData: (data: string) => void;
  private onExit: (code: number, signal?: NodeJS.Signals | null) => void;
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
    this.stopping = false;
    const platform = process.platform;
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const binaryName = `augment-pty-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
    const sourcePath = join(this.pluginDir, "scripts", binaryName);
    const candidates: string[] = [sourcePath];
    try {
      const stagedPath = stageBinary(sourcePath, binaryName);
      if (stagedPath !== sourcePath) candidates.push(stagedPath);
    } catch {
      // Keep direct path candidate only.
    }

    const env: Record<string, string | undefined> = {
      ...process.env,
      TERM: "xterm-256color",
      LANG: process.env.LANG || "en_US.UTF-8",
      AUGMENT_SHELL: this.shellPath || process.env.SHELL || (platform === "win32" ? "cmd.exe" : "bash"),
      AUGMENT_CWD: this.cwd,
    };

    let candidateIndex = 0;
    const spawnCandidate = (): void => {
      const binaryPath = candidates[candidateIndex];
      const startedAt = Date.now();

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

      this.process.on("exit", (code, signal) => {
        const runtimeMs = Date.now() - startedAt;
        this.process = null;
        this.controlStream = null;

        const shouldFallback =
          !this.stopping &&
          candidateIndex + 1 < candidates.length &&
          signal === "SIGKILL" &&
          runtimeMs < 1200;
        if (shouldFallback) {
          candidateIndex++;
          spawnCandidate();
          return;
        }

        this.onExit(code ?? 0, signal ?? null);
      });

      this.process.on("error", (err) => {
        console.error("[augment-pty] Process error:", err);
        this.process = null;
        this.controlStream = null;

        const shouldFallback =
          !this.stopping && candidateIndex + 1 < candidates.length;
        if (shouldFallback) {
          candidateIndex++;
          spawnCandidate();
          return;
        }

        this.onError?.(err);
        this.onExit(1);
      });
    };

    spawnCandidate();
  }

  write(data: string): void {
    this.process?.stdin?.write(data);
  }

  resize(rows: number, cols: number): void {
    this.controlStream?.write(`R${rows},${cols}\n`);
  }

  kill(): void {
    this.stopping = true;
    if (this.process) {
      this.process.kill("SIGTERM");
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}
