import { spawn, ChildProcess, execFileSync } from "child_process";
import { join } from "path";
import { copyFileSync, existsSync, mkdirSync, chmodSync, statSync } from "fs";
import { tmpdir } from "os";
import { Writable } from "stream";

export interface PtyBridgeOptions {
  pluginDir: string;
  cwd: string;
  shellPath?: string;
  initialRows?: number;
  initialCols?: number;
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
      const sourceStat = statSync(sourcePath);
      const stagedStat = statSync(staged);
      // Compare mtime only. macOS ad-hoc signing mutates staged binary size.
      // Size-based invalidation would force a re-sign on every launch.
      needsCopy = sourceStat.mtimeMs > stagedStat.mtimeMs;
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
  private didExit = false;
  private pluginDir: string;
  private cwd: string;
  private shellPath: string;
  private initialRows: number;
  private initialCols: number;
  private onData: (data: string) => void;
  private onExit: (code: number, signal?: NodeJS.Signals | null) => void;
  private onError?: (err: Error) => void;

  constructor(opts: PtyBridgeOptions) {
    this.pluginDir = opts.pluginDir;
    this.cwd = opts.cwd;
    this.shellPath = opts.shellPath || "";
    this.initialRows = Number.isFinite(opts.initialRows) ? Math.max(0, Math.floor(opts.initialRows!)) : 0;
    this.initialCols = Number.isFinite(opts.initialCols) ? Math.max(0, Math.floor(opts.initialCols!)) : 0;
    this.onData = opts.onData;
    this.onExit = opts.onExit;
    this.onError = opts.onError;
  }

  // Launch strategy: staged path first, source path as fallback.
  //
  // macOS may SIGKILL binaries executed from certain paths. Two common cases:
  //
  //   1. Normal local install: plugin is in ~/.obsidian/plugins/ on a local
  //      APFS volume. macOS typically allows execution, but staging to $TMPDIR
  //      and applying an ad-hoc codesign adds an extra layer of reliability —
  //      the ad-hoc signature replaces the bare linker signature and satisfies
  //      Gatekeeper's ad-hoc path checks. codesign takes ~15ms on first launch
  //      (blocked synchronously); subsequent launches skip it via mtime check.
  //
  //   2. Synced vault (iCloud, Dropbox, etc.): plugin path may be under
  //      ~/Library/Mobile Documents/ or a cloud provider directory. macOS
  //      (and the cloud provider's file-provider daemon) may kill binaries
  //      executed from those paths. stageBinary() copies to $TMPDIR/augment-pty/
  //      which is always a local, non-cloud volume — execution succeeds there.
  //
  // On SIGKILL within 1.2s the spawn loop falls back from staged → source.
  // On process error (ENOENT, EACCES) it also falls back.
  start(): void {
    this.stopping = false;
    this.didExit = false;
    const platform = process.platform;
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const binaryName = `augment-pty-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
    const sourcePath = join(this.pluginDir, "scripts", binaryName);
    const candidates: string[] = [];
    try {
      const stagedPath = stageBinary(sourcePath, binaryName);
      // On macOS, try staged path first (avoids cloud-volume SIGKILL).
      // On other platforms, staged path is always a different location from
      // source, so also prefer it — provides a local-disk copy as first attempt.
      candidates.push(stagedPath);
    } catch {
      // stageBinary failed (e.g. source binary missing). Fall through to
      // source-path candidate, which will surface a meaningful error.
    }
    candidates.push(sourcePath);

    // On Windows, skip process.env.SHELL — it can leak from WSL-integrated
    // environments and would pass a Unix path like /bin/bash to ConPTY.
    const shellFallback = platform === "win32"
      ? "powershell.exe"
      : (process.env.SHELL || "bash");

    // WSL auto-translates the Windows CWD to /mnt/... when launched from
    // a Windows directory. No --cd or path translation needed — ConPTY
    // sets the CWD of wsl.exe to the native Windows path, and WSL handles
    // the mount-path mapping internally.
    const effectiveShell = this.shellPath || shellFallback;

    const env: Record<string, string | undefined> = {
      ...process.env,
      TERM: "xterm-256color",
      LANG: process.env.LANG || "en_US.UTF-8",
      AUGMENT_SHELL: effectiveShell,
      AUGMENT_CWD: this.cwd,
      // Pass initial dimensions so the Go binary creates the PTY at the
      // correct size — eliminates the race where the shell/TUI starts
      // painting before the fd-3 resize command arrives.
      AUGMENT_ROWS: this.initialRows > 0 ? String(this.initialRows) : undefined,
      AUGMENT_COLS: this.initialCols > 0 ? String(this.initialCols) : undefined,
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
      // Do NOT send an initial resize here. The Go binary already creates
      // the PTY at the correct size via AUGMENT_ROWS/AUGMENT_COLS env vars.
      // Sending a redundant fd-3 resize triggers an extra SIGWINCH that
      // interrupts the shell/TUI during its initial startup paint.

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

        if (this.didExit) return;
        this.didExit = true;
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

        if (this.didExit) return;
        this.didExit = true;
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
