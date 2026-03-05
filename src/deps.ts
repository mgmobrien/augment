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

function execAsync(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10000, env: shellEnv() }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function checkBool(cmd: string): Promise<boolean> {
  try {
    await execAsync(cmd);
    return true;
  } catch {
    return false;
  }
}

async function checkAuth(): Promise<boolean> {
  try {
    const r = await execAsync("claude auth status");
    const lower = r.stdout.toLowerCase();
    return !lower.includes("not logged in") && !lower.includes("not authenticated");
  } catch {
    return false;
  }
}

export async function detectDeps(app: App): Promise<CCDeps> {
  const vaultConfigured = !!app.vault.getAbstractFileByPath("CLAUDE.md");
  const node = await checkBool("node --version");
  const cc = node ? await checkBool(process.platform === "win32" ? "where claude" : "which claude") : false;
  const authed = cc ? await checkAuth() : false;
  return { node, cc, authed, vaultConfigured };
}
