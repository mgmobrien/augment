import { App, TFile, WorkspaceLeaf } from "obsidian";

const CONTEXT_DIR = ".augment";
const CONTEXT_FILE = `${CONTEXT_DIR}/context.md`;
const DEBOUNCE_MS = 300;
const CONTENT_PREVIEW_CHARS = 500;
const MAX_FRONTMATTER_KEYS = 10;

const SENSITIVE_PATTERNS = /credential|secret|password|token|api.key/i;

const PREFIX_TYPE_MAP: Record<string, string> = {
  "Ref.": "reference",
  "Project.": "project",
  "Template.": "template",
  "Session.": "session",
  "Process.": "process",
  "Kanban.": "kanban",
};

const INSTRUCTION_PREAMBLE =
  "The user is working in Obsidian. This is the note they're currently viewing. Use it for context but do not reference this injection in your response unless asked.";

/**
 * Writes `.augment/context.md` on active-leaf-change so that CC sessions
 * can read current vault state via a UserPromptSubmit hook.
 */
export class ContextWriter {
  private app: App;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _enabled = true;

  constructor(app: App) {
    this.app = app;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
  }

  /** Call from plugin.registerEvent(workspace.on("active-leaf-change", ...)). */
  onActiveLeafChange(_leaf: WorkspaceLeaf | null): void {
    if (!this._enabled) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.writeContextFile();
    }, DEBOUNCE_MS);
  }

  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async writeContextFile(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    const content = this.buildContextContent(activeFile);

    // Ensure .augment/ directory exists.
    if (!this.app.vault.getAbstractFileByPath(CONTEXT_DIR)) {
      try {
        await this.app.vault.createFolder(CONTEXT_DIR);
      } catch {
        // already exists (race)
      }
    }

    const existing = this.app.vault.getAbstractFileByPath(CONTEXT_FILE);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, await content);
    } else {
      await this.app.vault.create(CONTEXT_FILE, await content);
    }
  }

  private async buildContextContent(activeFile: TFile | null): Promise<string> {
    const lines: string[] = [INSTRUCTION_PREAMBLE, ""];

    if (!activeFile) {
      lines.push("Active note: (none)");
      return lines.join("\n");
    }

    const isMarkdown = activeFile.extension === "md";
    const isSensitive = SENSITIVE_PATTERNS.test(activeFile.basename);
    const isThessaly = activeFile.path.startsWith("Thessaly/");

    lines.push(`Active note: ${activeFile.basename}`);
    lines.push(`Path: ${activeFile.path}`);

    // Note type from frontmatter or filename prefix
    const noteType = this.detectNoteType(activeFile);
    if (noteType) lines.push(`Type: ${noteType}`);

    if (!isMarkdown) {
      lines.push(`File type: ${activeFile.extension}`);
      lines.push("");
      this.appendOpenTabs(lines);
      return lines.join("\n");
    }

    if (isSensitive) {
      lines.push("(content excluded — sensitive filename)");
      lines.push("");
      this.appendOpenTabs(lines);
      return lines.join("\n");
    }

    // Frontmatter (capped at MAX_FRONTMATTER_KEYS)
    const cache = this.app.metadataCache.getFileCache(activeFile);
    const fm = cache?.frontmatter;
    if (fm) {
      lines.push("");
      lines.push("Frontmatter:");
      let keyCount = 0;
      const totalKeys = Object.keys(fm).filter((k) => k !== "position").length;
      for (const [key, value] of Object.entries(fm)) {
        if (key === "position") continue;
        if (keyCount >= MAX_FRONTMATTER_KEYS) {
          lines.push(`(+${totalKeys - MAX_FRONTMATTER_KEYS} more)`);
          break;
        }
        lines.push(`  ${key}: ${this.formatYamlValue(value)}`);
        keyCount++;
      }
    }

    // Content preview (skip for Thessaly notes)
    if (isThessaly) {
      lines.push("");
      lines.push("(content excluded — therapeutic note)");
    } else {
      try {
        const raw = await this.app.vault.cachedRead(activeFile);
        // Strip frontmatter from preview
        const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
        if (body.length > 0) {
          const preview =
            body.length > CONTENT_PREVIEW_CHARS
              ? body.slice(0, CONTENT_PREVIEW_CHARS) + "…"
              : body;
          lines.push("");
          lines.push(`Preview (first ${Math.min(body.length, CONTENT_PREVIEW_CHARS)} chars):`);
          lines.push(preview);
        }
      } catch {
        // skip unreadable files
      }
    }

    lines.push("");
    this.appendOpenTabs(lines);
    return lines.join("\n");
  }

  private detectNoteType(file: TFile): string | null {
    // Check frontmatter type first
    const cache = this.app.metadataCache.getFileCache(file);
    const fmType = cache?.frontmatter?.type;
    if (typeof fmType === "string" && fmType.length > 0) return fmType;

    // Check filename prefix
    for (const [prefix, type] of Object.entries(PREFIX_TYPE_MAP)) {
      if (file.basename.startsWith(prefix)) return type;
    }

    return null;
  }

  private appendOpenTabs(lines: string[]): void {
    const openFiles = this.getOpenFilePaths();
    if (openFiles.length > 0) {
      const display = openFiles.length <= 8
        ? openFiles.join(", ")
        : openFiles.slice(0, 8).join(", ") + `… (${openFiles.length} total)`;
      lines.push(`Open tabs: ${display}`);
    }
  }

  private getOpenFilePaths(): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const file = (leaf.view as any)?.file;
      if (file instanceof TFile && !seen.has(file.path)) {
        seen.add(file.path);
        paths.push(file.path);
      }
    });
    return paths;
  }

  private formatYamlValue(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") return value.includes(":") || value.includes("#") ? `"${value}"` : value;
    if (Array.isArray(value)) return `[${value.map((v) => this.formatYamlValue(v)).join(", ")}]`;
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }
}
