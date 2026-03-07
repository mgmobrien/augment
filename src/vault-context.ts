import { App, Editor, TFile } from "obsidian";

export type TerminalOpenLocation = "tab" | "split-right" | "split-down" | "sidebar-right" | "sidebar-left" | "sidebar-right-top" | "sidebar-right-bottom" | "sidebar-left-top" | "sidebar-left-bottom";

export interface SessionRecord {
  id: string;
  name: string;
  skillName?: string;
  status: "exited" | "crashed";
  startedAt: number;
  closedAt: number;
  conversationPath?: string;
}

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
  shellPath: string;
  defaultWorkingDirectory: string;
  setupCardDismissed: boolean;
  hasGenerated: boolean;
  hasUsedTemplate: boolean;
  hasSeenWelcome: boolean;
  systemPrompt: string;
  showGenerationToast: boolean;
  clearedLinkHotkey: boolean;
  clearedHotkeyOriginals: Record<string, unknown>; // original binding values captured before Augment cleared them
  terminalSetupDone: boolean;
  terminalSetupBypassed: boolean;
  defaultTerminalLocation: TerminalOpenLocation;
  showOtherProjects: boolean;
  sessionHistory: SessionRecord[];
  coloredRibbonIcon: boolean;
  ribbonIcon: string;
}

export const DEFAULT_SETTINGS: AugmentSettings = {
  apiKey: "",
  model: "auto",
  templateFolder: "",
  linkedNoteCount: 3,
  maxContextTokens: 2000,
  showTemplatePreview: true,
  outputFormat: "plain",
  headingLevel: 2,
  calloutType: "ai",
  calloutExpanded: true,
  shellPath: "",
  defaultWorkingDirectory: "",
  setupCardDismissed: false,
  hasGenerated: false,
  hasUsedTemplate: false,
  hasSeenWelcome: false,
  systemPrompt: "",
  showGenerationToast: true,
  clearedLinkHotkey: false,
  clearedHotkeyOriginals: {},
  terminalSetupDone: false,
  terminalSetupBypassed: false,
  defaultTerminalLocation: "tab",
  showOtherProjects: false,
  sessionHistory: [],
  coloredRibbonIcon: false,
  ribbonIcon: "augment-pyramid",
};

export interface SpendModelEntry {
  inputTokens: number;
  outputTokens: number;
  generations: number;
}

export interface SpendData {
  byModel: Record<string, SpendModelEntry>;
  since?: number; // Date.now() when tracking started (or was last reset)
}

export interface LinkedNoteSummary {
  title: string;
  frontmatter: Record<string, unknown> | null;
  content?: string;
}

export interface ContextEntry {
  timestamp: number;      // Date.now(); 0 = preview (no generation happened)
  noteName: string;       // ctx.title
  model: string;          // resolved display name (e.g. "Claude Haiku 4.5")
  systemPrompt: string;   // buildSystemPrompt(ctx)
  userMessage: string;    // buildUserMessage(ctx, instruction) or rendered template
}

export interface VaultContext {
  title: string;
  frontmatter: Record<string, unknown> | null;
  selection: string;
  surroundingContext: string;
  linkedNotes: LinkedNoteSummary[];
  content?: string;
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
    if (cursor.line > 0 || cursor.ch > 0) {
      const lines: string[] = [];
      for (let i = 0; i < cursor.line; i++) {
        lines.push(editor.getLine(i));
      }
      const lastLine = editor.getLine(cursor.line).slice(0, cursor.ch);
      if (lastLine) lines.push(lastLine);
      surroundingContext = lines.join("\n");
    }
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

// Populate LinkedNoteSummary.content for each linked note via vault read.
// Call inside an async context after assembleVaultContext(); caps per-note content to avoid
// blowing the context budget (default 3 000 chars ≈ ~750 tokens per note).
export async function populateLinkedNoteContent(
  app: App,
  ctx: VaultContext,
  maxCharsPerNote = 3_000
): Promise<void> {
  for (const note of ctx.linkedNotes) {
    const file = app.vault.getFiles().find((f) => f.basename === note.title);
    if (!file) continue;
    try {
      const raw = await app.vault.cachedRead(file);
      note.content = raw.length > maxCharsPerNote ? raw.slice(0, maxCharsPerNote) + "\u2026" : raw;
    } catch {
      // skip unreadable files
    }
  }
}

// Editor-free context assembly for skill invocation — reads file content from vault cache.
export async function assembleNoteContext(
  app: App,
  file: TFile,
  settings: AugmentSettings
): Promise<VaultContext> {
  const title = file.basename;
  const rawFrontmatter = app.metadataCache.getFileCache(file)?.frontmatter ?? null;
  const frontmatter = stripObsidianMeta(rawFrontmatter);

  const content = await app.vault.cachedRead(file);
  // Use first 200 lines as surroundingContext — no cursor position available.
  const surroundingContext = content.split("\n").slice(0, 200).join("\n");

  const linkedNotes: LinkedNoteSummary[] = [];
  if (settings.linkedNoteCount > 0) {
    const links = app.metadataCache.getFileCache(file)?.links ?? [];
    for (const link of links) {
      if (linkedNotes.length >= settings.linkedNoteCount) break;
      const resolved = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
      if (!resolved) continue;
      const cache = app.metadataCache.getFileCache(resolved);
      linkedNotes.push({
        title: resolved.basename,
        frontmatter: stripObsidianMeta(cache?.frontmatter ?? null),
      });
    }
  }

  return { title, frontmatter, selection: "", surroundingContext, linkedNotes };
}
