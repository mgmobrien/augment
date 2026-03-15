import { App, TFile, WorkspaceLeaf } from "obsidian";

const CONTEXT_DIR = ".augment";
const CONTEXT_FILE = `${CONTEXT_DIR}/context.md`;
const DEBOUNCE_MS = 300;
const CONTENT_PREVIEW_CHARS = 2000;

/**
 * Writes `.augment/context.md` on active-leaf-change so that CC sessions
 * can read current vault state via a UserPromptSubmit hook.
 */
export class ContextWriter {
  private app: App;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App) {
    this.app = app;
  }

  /** Call from plugin.registerEvent(workspace.on("active-leaf-change", ...)). */
  onActiveLeafChange(_leaf: WorkspaceLeaf | null): void {
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
    const content = await this.buildContextContent(activeFile);

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
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(CONTEXT_FILE, content);
    }
  }

  private async buildContextContent(activeFile: TFile | null): Promise<string> {
    const sections: string[] = [];

    sections.push("# Obsidian vault context");
    sections.push("");
    sections.push(`_Updated: ${new Date().toLocaleString()}_`);
    sections.push("");

    // Active note
    if (activeFile) {
      sections.push("## Active note");
      sections.push("");
      sections.push(`**Path:** ${activeFile.path}`);
      sections.push(`**Title:** ${activeFile.basename}`);
      sections.push("");

      // Frontmatter
      const cache = this.app.metadataCache.getFileCache(activeFile);
      const fm = cache?.frontmatter;
      if (fm) {
        sections.push("### Frontmatter");
        sections.push("");
        sections.push("```yaml");
        for (const [key, value] of Object.entries(fm)) {
          if (key === "position") continue; // Obsidian internal
          sections.push(`${key}: ${this.formatYamlValue(value)}`);
        }
        sections.push("```");
        sections.push("");
      }

      // Content preview
      try {
        const raw = await this.app.vault.cachedRead(activeFile);
        const preview =
          raw.length > CONTENT_PREVIEW_CHARS
            ? raw.slice(0, CONTENT_PREVIEW_CHARS) + "\n…(truncated)"
            : raw;
        sections.push("### Content preview");
        sections.push("");
        sections.push(preview);
        sections.push("");
      } catch {
        // skip unreadable files
      }
    } else {
      sections.push("## Active note");
      sections.push("");
      sections.push("_No note is currently active._");
      sections.push("");
    }

    // Open tabs
    const openFiles = this.getOpenFilePaths();
    if (openFiles.length > 0) {
      sections.push("## Open tabs");
      sections.push("");
      for (const path of openFiles) {
        sections.push(`- ${path}`);
      }
      sections.push("");
    }

    return sections.join("\n");
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
