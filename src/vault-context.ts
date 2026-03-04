import { App, Editor } from "obsidian";

export interface AugmentSettings {
  apiKey: string;
  model: string;
  templateFolder: string;
  linkedNoteCount: number;
  maxContextTokens: number;
  showTemplatePreview: boolean;
  outputFormat: "plain" | "codeblock" | "blockquote" | "heading" | "callout";
  headingLevel: number;
  calloutType: string;
  calloutExpanded: boolean;
  useWsl: boolean;
}

export const DEFAULT_SETTINGS: AugmentSettings = {
  apiKey: "",
  model: "auto",
  templateFolder: "Augment/templates",
  linkedNoteCount: 3,
  maxContextTokens: 2000,
  showTemplatePreview: true,
  outputFormat: "plain",
  headingLevel: 2,
  calloutType: "ai",
  calloutExpanded: true,
  useWsl: false,
};

export interface LinkedNoteSummary {
  title: string;
  frontmatter: Record<string, unknown> | null;
}

export interface VaultContext {
  title: string;
  frontmatter: Record<string, unknown> | null;
  selection: string;
  surroundingContext: string;
  linkedNotes: LinkedNoteSummary[];
}

// Strip Obsidian's internal `position` key from frontmatter cache objects.
function stripObsidianMeta(fm: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!fm) return null;
  const { position, ...rest } = fm as any;
  return Object.keys(rest).length > 0 ? rest : null;
}

export function assembleVaultContext(
  app: App,
  editor: Editor,
  settings: AugmentSettings
): VaultContext {
  const activeFile = app.workspace.getActiveFile();
  const title = activeFile?.basename ?? "Untitled";

  const rawFrontmatter = activeFile
    ? (app.metadataCache.getFileCache(activeFile)?.frontmatter ?? null)
    : null;
  const frontmatter = stripObsidianMeta(rawFrontmatter);

  const selection = editor.getSelection();
  let surroundingContext = "";
  if (!selection) {
    const cursor = editor.getCursor();
    const startLine = Math.max(0, cursor.line - 25);
    const endLine = Math.min(editor.lastLine(), cursor.line + 25);
    const lines: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      lines.push(editor.getLine(i));
    }
    surroundingContext = lines.join("\n");
  }

  const linkedNotes: LinkedNoteSummary[] = [];
  if (activeFile && settings.linkedNoteCount > 0) {
    const links = app.metadataCache.getFileCache(activeFile)?.links ?? [];
    for (const link of links) {
      if (linkedNotes.length >= settings.linkedNoteCount) break;
      const resolved = app.metadataCache.getFirstLinkpathDest(link.link, activeFile.path);
      if (!resolved) continue;
      const cache = app.metadataCache.getFileCache(resolved);
      linkedNotes.push({
        title: resolved.basename,
        frontmatter: stripObsidianMeta(cache?.frontmatter ?? null),
      });
    }
  }

  return { title, frontmatter, selection, surroundingContext, linkedNotes };
}
