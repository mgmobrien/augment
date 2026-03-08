import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface SessionMeta {
  id: string;         // JSONL filename without extension
  resumeId: string;   // Claude sessionId used by `claude --resume`
  title: string;      // first user message, ~60 chars
  titleFull: string;  // longer excerpt for tooltip, ~250 chars
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

type SessionSummary = {
  msgCount: number;
  resumeId: string | null;
  title: string;
  titleFull: string;
};

export class SessionStore {
  private summaryCache = new Map<string, { mtimeMs: number; summary: SessionSummary }>();

  constructor(private vaultBasePath: string) {}

  // Locate ~/.claude/projects/[encoded-cwd]/ for this vault.
  // CC encodes cwd by replacing '/' and spaces with '-'.
  async findProjectDir(): Promise<string | null> {
    const home = process.env.HOME ?? os.homedir();
    const encoded = this.vaultBasePath.replace(/[/\\ ]/g, "-");
    const dir = path.join(home, ".claude", "projects", encoded);
    try {
      if ((await fs.promises.stat(dir)).isDirectory()) return dir;
    } catch {}
    return null;
  }

  // Enumerate all project directories under ~/.claude/projects/.
  async findAllProjectDirs(): Promise<Array<{
    encodedName: string;
    projectDir: string;
    isVault: boolean;
    projectName: string;
  }>> {
    const home = process.env.HOME ?? os.homedir();
    const projectsRoot = path.join(home, ".claude", "projects");
    const vaultEncoded = this.vaultBasePath.replace(/[/ ]/g, "-");
    const encodedHome = home.replace(/[/ ]/g, "-");

    try {
      const names = await fs.promises.readdir(projectsRoot);
      const dirs = await Promise.all(
        names.map(async (encodedName) => {
          const projectDir = path.join(projectsRoot, encodedName);
          try {
            const stat = await fs.promises.stat(projectDir);
            if (!stat.isDirectory()) return null;
          } catch {
            return null;
          }

          const isVault = encodedName === vaultEncoded;
          // Decode: strip home-dir prefix, convert remaining dashes to slashes.
          // Lossy (spaces and slashes both encoded as dashes) but readable.
          const relative = encodedName.startsWith(encodedHome)
            ? encodedName.slice(encodedHome.length).replace(/^-+/, "")
            : encodedName.replace(/^-+/, "");
          const projectName = relative.replace(/-/g, "/") || encodedName;
          return { encodedName, projectDir, isVault, projectName };
        })
      );

      return dirs.filter((d): d is NonNullable<typeof d> => d !== null);
    } catch {
      return [];
    }
  }

  // Sort session files by mtime desc, take first `limit`.
  async loadSessions(limit: number): Promise<SessionMeta[]> {
    const dir = await this.findProjectDir();
    if (!dir) return [];
    return (await this.loadSessionsFromDir(dir, limit)).sessions;
  }

  // Load sessions from all CC project directories, grouped by project.
  // Vault project is flagged with isVault=true.
  async loadAllProjectGroups(limitPerProject = 50): Promise<ProjectGroup[]> {
    const dirs = await this.findAllProjectDirs();
    const groups = await Promise.all(
      dirs.map(async ({ encodedName, projectDir, isVault, projectName }) => {
        const { sessions, totalOnDisk } = await this.loadSessionsFromDir(projectDir, limitPerProject);
        if (sessions.length === 0) return null;
        const lastActivityMs = sessions[0]?.mtimeMs ?? 0;
        return {
          projectName,
          projectDir,
          encodedName,
          isVault,
          sessions,
          totalOnDisk,
          lastActivityMs,
        };
      })
    );

    return groups
      .filter((g): g is ProjectGroup => g !== null)
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }

  private async loadSessionsFromDir(dir: string, limit: number): Promise<{ sessions: SessionMeta[]; totalOnDisk: number }> {
    try {
      const now = Date.now();
      const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      const totalOnDisk = files.length;

      const entries = (
        await Promise.all(
          files.map(async (name) => {
            const fullPath = path.join(dir, name);
            try {
              const st = await fs.promises.stat(fullPath);
              return { name, fullPath, mtimeMs: st.mtimeMs };
            } catch {
              return null;
            }
          })
        )
      )
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit);

      const sessions = await Promise.all(
        entries.map(async (e) => {
          const id = e.name.slice(0, -6);
          const summary = await this.readSessionSummary(e.fullPath, id, e.mtimeMs);
          if (summary.msgCount <= 0) return null;
          return {
            id,
            resumeId: summary.resumeId ?? id,
            title: summary.title,
            titleFull: summary.titleFull,
            status: now - e.mtimeMs < 30_000 ? "stale" as const : "complete" as const,
            mtimeMs: e.mtimeMs,
            msgCount: summary.msgCount,
          };
        })
      );

      return { sessions: sessions.filter((s): s is SessionMeta => s !== null), totalOnDisk };
    } catch {
      return { sessions: [], totalOnDisk: 0 };
    }
  }

  private async readSessionSummary(
    sessionPath: string,
    fallbackTitle: string,
    mtimeMs: number
  ): Promise<SessionSummary> {
    const cached = this.summaryCache.get(sessionPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.summary;
    }

    try {
      const content = await fs.promises.readFile(sessionPath, "utf-8");
      const summary = this.parseSessionContent(content, fallbackTitle);
      this.summaryCache.set(sessionPath, { mtimeMs, summary });
      if (this.summaryCache.size > 200) {
        this.summaryCache.delete(this.summaryCache.keys().next().value!);
      }
      return summary;
    } catch {
      return { msgCount: 0, resumeId: null, title: fallbackTitle };
    }
  }

  private parseSessionContent(content: string, fallbackTitle: string): SessionSummary {
    let firstUserTitle: string | null = null;
    let firstUserRaw: string | null = null;
    let firstAssistantText: string | null = null;
    let firstAssistantRaw: string | null = null;
    let explicitRenameTitle: string | null = null;
    let resumeId: string | null = null;
    let msgCount = 0;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        if (!resumeId && typeof obj?.sessionId === "string" && obj.sessionId.trim()) {
          resumeId = obj.sessionId.trim();
        }

        const command = obj?.data?.command;
        if (typeof command === "string" && command.trim()) {
          const renamed = this.extractExplicitRenameTitle(command);
          if (renamed) {
            explicitRenameTitle = renamed;
          }
        }

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

          if (text.trim() && !this.isMetaUserText(text)) {
            msgCount++;
            if (!firstUserTitle) {
              const cleaned = this.cleanTitle(text);
              if (cleaned) {
                firstUserTitle = cleaned;
                firstUserRaw = text;
              }
            }
          }
        }

        if (!firstAssistantText && obj.type === "assistant") {
          const msgContent = obj.message?.content;
          if (Array.isArray(msgContent)) {
            for (const block of msgContent) {
              if (block?.type === "text" && typeof block.text === "string") {
                const text = block.text.trim();
                // Take up to the first sentence boundary on the first line.
                const firstLine = text.replace(/\n[\s\S]*/m, "").trim();
                const sentence = firstLine.replace(/[.!?].*/, "").trim();
                const candidate = (sentence.length > 5 ? sentence : firstLine).slice(0, 55);
                if (candidate.length > 3) {
                  firstAssistantText = candidate;
                  firstAssistantRaw = firstLine.slice(0, 200);
                }
                break;
              }
            }
          }
        }
      } catch {}
    }

    // Concatenate user message + assistant excerpt, separated by " — ", capped at 60 chars.
    // Explicit rename wins outright; otherwise join whatever parts exist; fall back to UUID.
    const parts: string[] = [];
    if (firstUserTitle) parts.push(firstUserTitle);
    if (firstAssistantText) parts.push(firstAssistantText);
    const combined = parts.join(" — ").slice(0, 60) || fallbackTitle;
    const title = explicitRenameTitle ?? combined;

    // Longer version for hover tooltip (~250 chars).
    const longParts: string[] = [];
    if (firstUserRaw) {
      const userLong = this.cleanTitle(firstUserRaw, 180);
      if (userLong) longParts.push(userLong);
    } else if (firstUserTitle) {
      longParts.push(firstUserTitle);
    }
    if (firstAssistantRaw) {
      longParts.push(firstAssistantRaw);
    } else if (firstAssistantText) {
      longParts.push(firstAssistantText);
    }
    const titleFull = explicitRenameTitle ?? (longParts.join(" — ").slice(0, 280) || fallbackTitle);

    return { msgCount, resumeId, title, titleFull };
  }

  private extractExplicitRenameTitle(command: string): string | null {
    const paneHook = command.match(
      /pane-name\.sh[\s\S]*?topic\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s)]+))/i
    );
    if (paneHook) {
      return this.normalizeExplicitTitle(
        paneHook[1] ?? paneHook[2] ?? paneHook[3] ?? paneHook[4] ?? ""
      );
    }

    const tmuxSelect = command.match(
      /\btmux\b[\s\S]*?\bselect-pane\b[\s\S]*?\s-T\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s)]+))/i
    );
    if (tmuxSelect) {
      return this.normalizeExplicitTitle(
        tmuxSelect[1] ?? tmuxSelect[2] ?? tmuxSelect[3] ?? tmuxSelect[4] ?? ""
      );
    }

    const tmuxWindow = command.match(
      /\btmux\b[\s\S]*?\brename-window\b[\s\S]*?(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s)]+))/i
    );
    if (tmuxWindow) {
      return this.normalizeExplicitTitle(
        tmuxWindow[1] ?? tmuxWindow[2] ?? tmuxWindow[3] ?? tmuxWindow[4] ?? ""
      );
    }

    return null;
  }

  private normalizeExplicitTitle(value: string): string | null {
    const compact = value
      .replace(/\\n/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\(["'`\\])/g, "$1")
      .trim();
    if (!compact) return null;

    // If the title is slug-style, render it as readable words in history.
    const readable =
      compact.includes(" ") ? compact : compact.replace(/[-_]+/g, " ");
    const cleaned = readable.replace(/\s+/g, " ").trim();
    return cleaned ? cleaned.slice(0, 60) : null;
  }

  private isMetaUserText(text: string): boolean {
    // Strip known system-injected blocks before checking for real user content.
    // A message may have real text with hook output appended — the real text still counts.
    const stripped = text
      .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/gi, "")
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "")
      .replace(/<command-name>[\s\S]*?<\/command-name>/gi, "")
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!stripped) return true;
    // A message that is entirely one XML element — skip regardless of length.
    if (/^<[^>]+>[\s\S]*<\/[^>]+>$/.test(stripped)) return true;
    return false;
  }

  private cleanTitle(raw: string, limit = 60): string | null {
    const compact = raw.replace(/\s+/g, " ").trim();
    if (!compact) return null;

    const teammate = this.cleanTeammateXmlTitle(compact, limit);
    if (teammate) return teammate.slice(0, limit);

    // Remove system-injected tag blocks entirely (tag + content) before stripping.
    // Stripping just the tags would leave the injected content as the title text.
    const deSystemed = compact
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
      .replace(/<env>[\s\S]*?<\/env>/gi, " ")
      .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/gi, " ")
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, " ")
      .replace(/<command-name>[\s\S]*?<\/command-name>/gi, " ")
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!deSystemed) return null;

    // Strip any remaining XML tags.
    const stripped = deSystemed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!stripped) return null;

    const roleForwarded = stripped.match(
      /^You are (?:a|the)\s+(.+?)(?:\s+for\b|\.|,|$)/i
    );
    if (roleForwarded?.[1]) {
      const role = roleForwarded[1].replace(/\s+part$/i, "").trim();
      const project = stripped.match(/\bfor (?:the )?(.+?)(?: project|\.)/i)?.[1]?.trim();
      const label = project ? `${role} - ${project}` : role;
      return label.slice(0, limit);
    }

    return stripped.slice(0, limit);
  }

  private cleanTeammateXmlTitle(text: string, limit = 60): string | null {
    const xml = text.match(
      /<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>/i
    );
    if (!xml) return null;

    const attrs = xml[1] ?? "";
    const body = (xml[2] ?? "").replace(/\s+/g, " ").trim();
    const teammateId =
      attrs.match(/\bteammate_id="([^"]+)"/i)?.[1]?.trim() ??
      attrs.match(/\brecipient="([^"]+)"/i)?.[1]?.trim() ??
      null;
    const summary = attrs.match(/\bsummary="([^"]+)"/i)?.[1]?.trim() ?? null;

    if (summary && teammateId) return `${teammateId} - ${summary}`;
    if (summary) return summary;

    const role = body.match(/^You are (?:a|the)\s+(.+?)(?:\s+for\b|\.|,|$)/i)?.[1]?.trim();
    const project = body.match(/\bfor (?:the )?(.+?)(?: project|\.)/i)?.[1]?.trim();
    if (role && project) return `${role} - ${project}`;
    if (role) return role;
    if (teammateId) return teammateId;
    if (body) return body.slice(0, limit);
    return null;
  }
}
