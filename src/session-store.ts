import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface SessionMeta {
  id: string;         // JSONL filename without extension
  title: string;      // first user message, ~60 chars
  status: "stale" | "complete";
  mtimeMs: number;
}

export class SessionStore {
  private titleCache = new Map<string, string>();

  constructor(private vaultBasePath: string) {}

  // Locate ~/.claude/projects/[encoded-cwd]/ for this vault.
  // CC encodes cwd by replacing '/' and spaces with '-'.
  findProjectDir(): string | null {
    const home = process.env.HOME ?? os.homedir();
    const encoded = this.vaultBasePath.replace(/[/ ]/g, "-");
    const dir = path.join(home, ".claude", "projects", encoded);
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {}
    return null;
  }

  // Sort session files by mtime desc, take first `limit`.
  loadSessions(limit: number): SessionMeta[] {
    const dir = this.findProjectDir();
    if (!dir) return [];

    try {
      const now = Date.now();
      const entries = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const fullPath = path.join(dir, f);
          try {
            const mtimeMs = fs.statSync(fullPath).mtimeMs;
            return { name: f, fullPath, mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit);

      return entries.map((e) => ({
        id: e.name.slice(0, -6), // strip .jsonl
        title: this.readTitle(e.fullPath),
        status: now - e.mtimeMs < 30_000 ? "stale" : "complete",
        mtimeMs: e.mtimeMs,
      }));
    } catch {
      return [];
    }
  }

  // Fast count of all session files — no stats or reads.
  countSessions(): number {
    const dir = this.findProjectDir();
    if (!dir) return 0;
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
    } catch {
      return 0;
    }
  }

  // Read first user message from session JSONL for display as title.
  private readTitle(sessionPath: string): string {
    if (this.titleCache.has(sessionPath)) {
      return this.titleCache.get(sessionPath)!;
    }

    let title = path.basename(sessionPath, ".jsonl");

    try {
      const content = fs.readFileSync(sessionPath, "utf-8");
      outer: for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "user") {
            const msgContent = obj.message?.content;
            let text = "";
            if (typeof msgContent === "string") {
              text = msgContent;
            } else if (Array.isArray(msgContent)) {
              for (const block of msgContent) {
                if (block?.type === "text" && typeof block.text === "string") {
                  text = block.text;
                  break;
                }
              }
            }
            if (text.trim()) {
              title = text.trim().slice(0, 60);
              break outer;
            }
          }
        } catch {}
      }
    } catch {}

    this.titleCache.set(sessionPath, title);
    return title;
  }
}
