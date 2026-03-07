import { App } from "obsidian";
import { exec } from "child_process";
import { existsSync } from "fs";
import * as path from "path";

export interface CCDeps {
  node: boolean;
  cc: boolean;
  authed: boolean;
  vaultConfigured: boolean;
}

type RuntimeDeps = Omit<CCDeps, "vaultConfigured">;

type DetectDepsOptions = {
  forceFresh?: boolean;
};

type RuntimeDepsCache = {
  value: RuntimeDeps;
  expiresAt: number;
};

const DETECT_DEPS_SUCCESS_TTL_MS = 60_000;

let cachedRuntimeDeps: RuntimeDepsCache | null = null;
let runtimeDepsInFlight: Promise<RuntimeDeps> | null = null;
let runtimeDepsEpoch = 0;

// Electron inherits a minimal PATH that often lacks ~/.local/bin, ~/.nvm, etc.
// Prepend common install locations so `which claude` and `node --version` work.
function shellEnv(): Record<string, string> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const extra = [
    path.join(home, ".local", "bin"),
    path.join(home, ".nvm", "versions", "node"),  // nvm
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ].filter((p) => existsSync(p));
  const current = process.env.PATH || "";
  return { ...process.env, PATH: [...extra, current].join(path.delimiter) };
}

function execAsync(cmd: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10000, env }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function checkBool(cmd: string, env: Record<string, string>): Promise<boolean> {
  try {
    await execAsync(cmd, env);
    return true;
  } catch {
    // On Windows, retry via WSL if the native check fails.
    if (process.platform === "win32") {
      try {
        const wslCmd = cmd.startsWith("where ") ? "which " + cmd.slice(6) : cmd;
        await execAsync(`wsl ${wslCmd}`, env);
        return true;
      } catch { /* fall through */ }
    }
    return false;
  }
}

async function checkAuth(env: Record<string, string>): Promise<boolean> {
  const check = async (cmd: string): Promise<boolean> => {
    try {
      const r = await execAsync(cmd, env);
      const lower = r.stdout.toLowerCase();
      return !lower.includes("not logged in") && !lower.includes("not authenticated");
    } catch {
      return false;
    }
  };
  const result = await check("claude auth status");
  if (result) return true;
  if (process.platform === "win32") return check("wsl claude auth status");
  return false;
}

async function detectRuntimeDeps(options: DetectDepsOptions = {}): Promise<RuntimeDeps> {
  const { forceFresh = false } = options;
  const now = Date.now();

  if (!forceFresh && cachedRuntimeDeps && cachedRuntimeDeps.expiresAt > now) {
    return cachedRuntimeDeps.value;
  }

  if (!forceFresh && runtimeDepsInFlight) {
    return runtimeDepsInFlight;
  }

  const epoch = runtimeDepsEpoch;
  const env = shellEnv();
  const run = (async () => {
    const node = await checkBool("node --version", env);
    const cc = node ? await checkBool(process.platform === "win32" ? "where claude" : "which claude", env) : false;
    const authed = cc ? await checkAuth(env) : false;
    return { node, cc, authed };
  })();

  if (!forceFresh) {
    runtimeDepsInFlight = run;
  }

  try {
    const deps = await run;
    if (epoch === runtimeDepsEpoch) {
      if (deps.node && deps.cc && deps.authed) {
        cachedRuntimeDeps = {
          value: deps,
          expiresAt: Date.now() + DETECT_DEPS_SUCCESS_TTL_MS,
        };
      } else {
        cachedRuntimeDeps = null;
      }
    }
    return deps;
  } finally {
    if (!forceFresh && runtimeDepsInFlight === run) {
      runtimeDepsInFlight = null;
    }
  }
}

export function invalidateDepsCache(): void {
  runtimeDepsEpoch++;
  cachedRuntimeDeps = null;
  runtimeDepsInFlight = null;
}

export async function detectDeps(app: App, options: DetectDepsOptions = {}): Promise<CCDeps> {
  const vaultConfigured = !!app.vault.getAbstractFileByPath("CLAUDE.md");
  const runtimeDeps = await detectRuntimeDeps(options);
  return { ...runtimeDeps, vaultConfigured };
}
