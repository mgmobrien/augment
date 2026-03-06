import { App, FuzzyMatch, FuzzySuggestModal, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import { AugmentSettings, VaultContext } from "./vault-context";
import { generateText } from "./ai-client";

export function getTemplateFiles(app: App, folderPath: string): TFile[] {
  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!(folder instanceof TFolder)) return [];
  return folder.children.filter(
    (f): f is TFile => f instanceof TFile && f.extension === "md"
  );
}

export class TemplatePicker extends FuzzySuggestModal<TFile> {
  private files: TFile[];
  private onChoose: (file: TFile) => void;

  constructor(app: App, files: TFile[], onChoose: (file: TFile) => void) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder("Select a template...");
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.basename;
  }

  renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
    el.createEl("div", { text: match.item.basename });
    const desc = this.app.metadataCache.getFileCache(match.item)?.frontmatter?.["description"];
    if (desc && typeof desc === "string") {
      el.createEl("div", { cls: "augment-tpl-desc", text: desc });
    }
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

export class TemplatePreviewModal extends Modal {
  private renderedPrompt: string;
  private ctx: VaultContext;
  private onConfirm: (skipPreviewInFuture: boolean) => void;
  private skipPreview = false;

  constructor(
    app: App,
    renderedPrompt: string,
    ctx: VaultContext,
    onConfirm: (skipPreviewInFuture: boolean) => void
  ) {
    super(app);
    this.renderedPrompt = renderedPrompt;
    this.ctx = ctx;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("augment-gen-preview-modal");

    const pre = contentEl.createEl("pre", { cls: "augment-gen-preview-prompt" });
    pre.setText(this.renderedPrompt);

    const linkedCount = this.ctx.linkedNotes.length;
    const summaryText =
      linkedCount > 0
        ? `Will include: ${this.ctx.title} + ${linkedCount} linked note${linkedCount > 1 ? "s" : ""}`
        : `Will include: ${this.ctx.title}`;
    contentEl.createEl("p", { text: summaryText, cls: "augment-gen-context-hint" });

    const charCount = this.renderedPrompt.length;
    const approxTokens = Math.round(charCount / 4);
    const isLarge = this.renderedPrompt.includes("{{note_content}}") ||
      this.renderedPrompt.includes("{{linked_notes_full}}") ||
      charCount > 4000;
    if (isLarge || charCount > 2000) {
      contentEl.createEl("p", {
        cls: "augment-gen-token-estimate" + (approxTokens > 4000 ? " is-large" : ""),
        text: `~${approxTokens.toLocaleString()} tokens (${charCount.toLocaleString()} chars)`,
      });
    }

    new Setting(contentEl)
      .setName("Don't show preview")
      .addToggle((toggle) => {
        toggle.setValue(false).onChange((val) => {
          this.skipPreview = val;
        });
      });

    const submit = () => {
      this.close();
      this.onConfirm(this.skipPreview);
    };

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText("Cancel").onClick(() => this.close());
      })
      .addButton((btn) => {
        btn.setButtonText("Generate").setCta().onClick(submit);
        btn.buttonEl.focus();
      });

    this.scope.register([], "Enter", (e) => {
      e.preventDefault();
      submit();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── Folder scan → template generation ───────────────────────────────────────

export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private onChoose: (folder: TFolder) => void;

  constructor(app: App, onChoose: (folder: TFolder) => void) {
    super(app);
    this.setPlaceholder("Select folder to scan\u2026");
    this.onChoose = onChoose;
  }

  getItems(): TFolder[] {
    const folders: TFolder[] = [];
    const collect = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          folders.push(child);
          collect(child);
        }
      }
    };
    collect(this.app.vault.getRoot());
    return folders.sort((a, b) => a.path.localeCompare(b.path));
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoose(folder);
  }
}

interface FolderAnalysis {
  folderPath: string;
  fileCount: number;
  frontmatterKeys: string[];
  headings: string[];
  samples: { title: string; excerpt: string }[];
}

async function analyzeFolderContents(app: App, folder: TFolder): Promise<FolderAnalysis> {
  const files = folder.children
    .filter((f): f is TFile => f instanceof TFile && f.extension === "md")
    .slice(0, 15);

  const keyFreq = new Map<string, number>();
  const headingFreq = new Map<string, number>();
  const samples: { title: string; excerpt: string }[] = [];

  for (const file of files) {
    try {
      const content = await app.vault.read(file);
      const cache = app.metadataCache.getFileCache(file);

      if (cache?.frontmatter) {
        for (const key of Object.keys(cache.frontmatter)) {
          if (key === "position") continue;
          keyFreq.set(key, (keyFreq.get(key) ?? 0) + 1);
        }
      }

      if (cache?.headings) {
        for (const h of cache.headings) {
          if (h.level <= 3) {
            headingFreq.set(h.heading, (headingFreq.get(h.heading) ?? 0) + 1);
          }
        }
      }

      const excerpt = content
        .replace(/^---[\s\S]*?---\n?/, "")
        .replace(/^#+\s.+$/gm, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 150);
      if (excerpt) samples.push({ title: file.basename, excerpt });
    } catch {
      // skip unreadable files
    }
  }

  const frontmatterKeys = [...keyFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k]) => k);

  const headings = [...headingFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([h]) => h);

  return { folderPath: folder.path, fileCount: files.length, frontmatterKeys, headings, samples: samples.slice(0, 5) };
}

export interface GeneratedTemplate {
  name: string;
  description: string;
  system_prompt: string | null;
  body: string;
}

export async function generateTemplatesFromFolder(
  app: App,
  folder: TFolder,
  settings: AugmentSettings,
  resolvedModel: string
): Promise<GeneratedTemplate[]> {
  const analysis = await analyzeFolderContents(app, folder);
  if (analysis.fileCount === 0) throw new Error("no-files");

  const lines: string[] = [
    `Folder: "${analysis.folderPath}" (${analysis.fileCount} notes scanned)`,
  ];
  if (analysis.frontmatterKeys.length > 0) {
    lines.push(`Frontmatter fields: ${analysis.frontmatterKeys.join(", ")}`);
  }
  if (analysis.headings.length > 0) {
    lines.push(`Common headings: ${analysis.headings.join(", ")}`);
  }
  if (analysis.samples.length > 0) {
    lines.push("Sample notes:");
    for (const s of analysis.samples) {
      lines.push(`  "${s.title}": ${s.excerpt}`);
    }
  }
  lines.push(
    "",
    "Generate 2\u20133 Handlebars prompt templates for working with notes in this folder. " +
    "Available variables: {{title}}, {{note_content}}, {{selection}}, {{linked_notes}}, {{frontmatter.KEY}}.",
    "",
    'Return ONLY a JSON array, no code fences: [{"name": string, "description": string, "system_prompt": string | null, "body": string}]',
    'The "body" is the prompt text (30\u2013120 words). The "system_prompt" is an optional custom instruction for Claude (null if not needed).'
  );

  const systemPrompt = "You generate Obsidian Augment prompt templates. Return ONLY valid JSON — an array of template objects, no other text, no code fences.";
  const raw = await generateText(systemPrompt, lines.join("\n"), settings, resolvedModel, undefined, 2048);

  // Strip code fences if present, then extract the JSON array.
  const cleaned = raw.replace(/```(?:json)?\n?/g, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("Response did not contain a JSON array");

  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Parsed value is not an array");

  return parsed
    .filter((t: any) => typeof t?.name === "string" && typeof t?.body === "string")
    .map((t: any): GeneratedTemplate => ({
      name: t.name.trim(),
      description: typeof t.description === "string" ? t.description.trim() : "",
      system_prompt: typeof t.system_prompt === "string" ? t.system_prompt.trim() : null,
      body: t.body.trim(),
    }))
    .slice(0, 5);
}

export function buildTemplateFileContent(t: GeneratedTemplate): string {
  const lines = ["---", `name: ${t.name}`];
  if (t.description) lines.push(`description: ${t.description}`);
  if (t.system_prompt) {
    lines.push("system_prompt: |");
    for (const l of t.system_prompt.split("\n")) {
      lines.push(`  ${l}`);
    }
  }
  lines.push("---", t.body);
  return lines.join("\n");
}

export class GeneratedTemplatesModal extends Modal {
  constructor(
    app: App,
    private templates: GeneratedTemplate[],
    private templateFolder: string,
    private onConfirm: (templates: GeneratedTemplate[]) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("augment-scan-modal");
    contentEl.createEl("h2", { text: "Generated templates" });
    contentEl.createEl("p", {
      cls: "augment-gen-context-hint",
      text: `${this.templates.length} template${this.templates.length !== 1 ? "s" : ""} ready. Will be created in \u201c${this.templateFolder}\u201d. Existing files won\u2019t be overwritten.`,
    });

    for (const t of this.templates) {
      const card = contentEl.createDiv({ cls: "augment-scan-template-card" });
      card.createEl("div", { cls: "augment-scan-template-name", text: t.name });
      if (t.description) {
        card.createEl("div", { cls: "augment-scan-template-desc", text: t.description });
      }
      const pre = card.createEl("pre", { cls: "augment-scan-template-body" });
      pre.textContent = t.body.length > 240 ? t.body.slice(0, 240) + "\u2026" : t.body;
    }

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((btn) => {
        btn.setButtonText("Create templates").setCta().onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Creating\u2026");
          await this.onConfirm(this.templates);
          this.close();
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
