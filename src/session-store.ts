import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface SessionMeta {
  id: string;         // JSONL filename without extension
  title: string;      // first user message, ~60 chars
  status: "stale" | "complete";
  mtimeMs: number;
  msgCount: number;   // number of user turns in the session
}

export interface ProjectGroup {
  projectName: string;    // decoded display name (e.g. "Development/relay-plugin")
  projectDir: string;     // full path to the project's CC session directory
  encodedName: string;    // raw subdirectory name in ~/.claude/projects/
  isVault: boolean;
  sessions: SessionMeta[];
  totalOnDisk: number;
  lastActivityMs: number; // mtime of most recent session
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

  // Enumerate all project directories under ~/.claude/projects/.
  findAllProjectDirs(): Array<{
    encodedName: string;
    projectDir: string;
    isVault: boolean;
    projectName: string;
  }> {
    const home = process.env.HOME ?? os.homedir();
    const projectsRoot = path.join(home, ".claude", "projects");
    const vaultEncoded = this.vaultBasePath.replace(/[/ ]/g, "-");
    const encodedHome = home.replace(/[/ ]/g, "-");

    try {
      return fs
        .readdirSync(projectsRoot)
        .filter((name) => {
          try {
            return fs.statSync(path.join(projectsRoot, name)).isDirectory();
          } catch {
            return false;
          }
        })
        .map((encodedName) => {
          const projectDir = path.join(projectsRoot, encodedName);
          const isVault = encodedName === vaultEncoded;

          // Decode: strip home-dir prefix, convert remaining dashes to slashes.
          // Lossy (spaces and slashes both encoded as dashes) but readable.
          let relative = encodedName.startsWith(encodedHome)
            ? encodedName.slice(encodedHome.length).replace(/^-+/, "")
            : encodedName.replace(/^-+/, "");
          const projectName = relative.replace(/-/g, "/") || encodedName;

          return { encodedName, projectDir, isVault, projectName };
        });
    } catch {
      return [];
    }
  }

  // Sort session files by mtime desc, take first `limit`.
  loadSessions(limit: number): SessionMeta[] {
    const dir = this.findProjectDir();
    if (!dir) return [];
    return this.loadSessionsFromDir(dir, limit);
  }

  // Load sessions from all CC project directories, grouped by project.
  // Vault project is flagged with isVault=true.
  loadAllProjectGroups(limitPerProject = 50): ProjectGroup[] {
    const dirs = this.findAllProjectDirs();
    const groups: ProjectGroup[] = [];

    for (const { encodedName, projectDir, isVault, projectName } of dirs) {
      const sessions = this.loadSessionsFromDir(projectDir, limitPerProject);
      if (sessions.length === 0) continue;
      const lastActivityMs = sessions[0]?.mtimeMs ?? 0;
      const totalOnDisk = this.countSessionsInDir(projectDir);
      groups.push({
        projectName,
        projectDir,
        encodedName,
        isVault,
        sessions,
        totalOnDisk,
        lastActivityMs,
      });
    }

    // Most recent project first.
    return groups.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }

  // Fast count of all session files — no stats or reads.
  countSessions(): number {
    const dir = this.findProjectDir();
    if (!dir) return 0;
    return this.countSessionsInDir(dir);
  }

  private countSessionsInDir(dir: string): number {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
    } catch {
      return 0;
    }
  }

  private loadSessionsFromDir(dir: string, limit: number): SessionMeta[] {
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
        msgCount: this.readMsgCount(e.fullPath),
      }));
    } catch {
      return [];
    }
  }

  // Count user turns in session JSONL.
  private readMsgCount(sessionPath: string): number {
    try {
      const content = fs.readFileSync(sessionPath, "utf-8");
      let count = 0;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "user") count++;
        } catch {}
      }
      return count;
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
