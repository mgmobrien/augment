import { App, FuzzyMatch, FuzzySuggestModal, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import { assembleNoteContext, AugmentSettings, populateLinkedNoteContent, VaultContext } from "./vault-context";
import { friendlyApiError, generateText, substituteVariables } from "./ai-client";

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

export const NO_FILES_ERROR = "no-files";

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

  await Promise.all(files.map(async (file) => {
    try {
      const content = await app.vault.cachedRead(file);
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
  }));

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
  if (analysis.fileCount === 0) throw new Error(NO_FILES_ERROR);

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
    "Generate 2\u20133 Liquid prompt templates for working with notes in this folder. " +
    "Available variables: {{ title }}, {{ note_content }}, {{ selection }}, {{ linked_notes }}, {{ frontmatter.KEY }}. " +
    "For per-linked-note formatting use: {% for note in linked_notes_array %}{{ note.title }}: {{ note.content }}{% endfor %}. " +
    "Filters: {{ title | truncate: 60 }}, {{ linked_notes_array | map: 'title' | join: ', ' }}. " +
    "Conditionals: {% if frontmatter.status %}...{% endif %}.",
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

// Shared flow: folder picker → generate → confirm modal → write files.
// onComplete is called after templates are created (e.g. to refresh a UI list).
export function runGenerateTemplatesFlow(
  app: App,
  settings: AugmentSettings,
  resolvedModel: string,
  onComplete?: () => void
): void {
  new FolderSuggestModal(app, async (folder) => {
    const notice = new Notice("Scanning folder and generating templates\u2026", 0);
    try {
      const templates = await generateTemplatesFromFolder(app, folder, settings, resolvedModel);
      notice.hide();
      const targetFolder = settings.templateFolder || "Augment/templates";
      new GeneratedTemplatesModal(app, templates, targetFolder, async (ts) => {
        if (!app.vault.getAbstractFileByPath(targetFolder)) {
          try { await app.vault.createFolder(targetFolder); } catch { /* already exists */ }
        }
        let created = 0;
        for (const t of ts) {
          const path = `${targetFolder}/${t.name}.md`;
          if (!app.vault.getAbstractFileByPath(path)) {
            await app.vault.create(path, buildTemplateFileContent(t));
            created++;
          }
        }
        if (created > 0) {
          new Notice(`Created ${created} template${created !== 1 ? "s" : ""}`);
          onComplete?.();
        } else {
          new Notice("All generated templates already exist \u2014 no files created");
        }
      }).open();
    } catch (err: any) {
      notice.hide();
      if (err?.message === NO_FILES_ERROR) {
        new Notice("No .md notes found in that folder");
      } else {
        new Notice("Template generation failed \u2014 see console for details");
        console.error("[Augment] generate-templates-from-folder failed", err);
      }
    }
  }).open();
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

// ── Template generation assistant ────────────────────────────────────────────

const TEMPLATE_ASSISTANT_PILLS = [
  "Summarize this note and its linked notes as bullet points",
  "Extract all action items from this note and its linked notes",
  "Write a synthesis from the linked notes that supports the thesis of this note",
  "Create a meeting notes template with agenda, attendees, decisions, and next steps",
];

const TEMPLATE_ASSISTANT_SYSTEM_PROMPT = `You write Liquid templates for the Augment Obsidian plugin.

Available variables:
- {{ title }} — note title (string)
- {{ note_content }} — full note text (string)
- {{ selection }} — currently selected text (string, may be empty)
- {{ context }} — text above cursor (string)
- {{ frontmatter.KEY }} — any frontmatter field (string). Example: {{ frontmatter.status }}
- {{ linked_notes }} — linked notes as a formatted text block (string)
- {{ linked_notes_full }} — linked notes with full content (string)
- {{ linked_notes_array }} — array of linked notes; each has .title (string), .frontmatter (object), .content (string)

Liquid syntax:
- Loop: {% for note in linked_notes_array %}{{ note.title }}: {{ note.content | truncate: 200 }}{% endfor %}
- Filter: {{ title | truncate: 60 }}
- Conditional: {% if frontmatter.status == "done" %}...{% endif %}
- Join filter: {{ linked_notes_array | map: "title" | join: ", " }}

Return ONLY the raw template text. No markdown fences, no explanation, no preamble.`;

export class TemplateAssistantModal extends Modal {
  private descriptionEl: HTMLTextAreaElement | null = null;
  private templateEditorEl: HTMLTextAreaElement | null = null;
  private previewEl: HTMLElement | null = null;
  private saveBtnEl: HTMLButtonElement | null = null;
  private generatedTemplate = "";
  private isGenerating = false;

  constructor(
    app: App,
    private settings: AugmentSettings,
    private resolvedModel: string,
    private targetFolder: string,
    private onSave: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("augment-tpl-assistant-modal");
    contentEl.createEl("h2", { text: "Generate template" });

    // Description input.
    contentEl.createEl("label", { cls: "augment-tpl-assistant-label", text: "Describe what you want" });
    const textarea = contentEl.createEl("textarea", { cls: "augment-tpl-assistant-desc" });
    textarea.placeholder = "Summarize this note and its linked notes as bullet points\u2026";
    textarea.rows = 3;
    this.descriptionEl = textarea;
    setTimeout(() => textarea.focus(), 50);

    // Starter example pills.
    const pillsEl = contentEl.createDiv({ cls: "augment-tpl-assistant-pills" });
    for (const pill of TEMPLATE_ASSISTANT_PILLS) {
      const btn = pillsEl.createEl("button", { cls: "augment-tpl-pill", text: pill });
      btn.addEventListener("click", () => {
        if (this.descriptionEl) {
          this.descriptionEl.value = pill;
          this.descriptionEl.focus();
        }
      });
    }

    // Generate button.
    const generateBtn = contentEl.createEl("button", {
      cls: "augment-tpl-assistant-generate mod-cta",
      text: "Generate",
    });
    generateBtn.addEventListener("click", () => void this.runGenerate(generateBtn));
    textarea.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.runGenerate(generateBtn);
      }
    });

    // Preview section.
    const previewSection = contentEl.createDiv({ cls: "augment-tpl-assistant-preview-section" });
    previewSection.createDiv({ cls: "augment-tpl-assistant-sep" }).createSpan({ text: "Preview" });

    previewSection.createEl("label", { cls: "augment-tpl-assistant-label", text: "Generated template" });
    this.templateEditorEl = previewSection.createEl("textarea", { cls: "augment-tpl-editor" });
    this.templateEditorEl.rows = 6;
    this.templateEditorEl.placeholder = "Generated template will appear here\u2026";

    previewSection.createEl("label", { cls: "augment-tpl-assistant-label", text: "Rendered output (against active note)" });
    this.previewEl = previewSection.createDiv({ cls: "augment-tpl-rendered-preview" });
    this.previewEl.textContent = "Generate a template to see a preview.";

    // Footer buttons.
    const footer = contentEl.createDiv({ cls: "augment-tpl-assistant-footer" });
    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { cls: "mod-cta", text: "Save" });
    saveBtn.disabled = true;
    this.saveBtnEl = saveBtn;
    saveBtn.addEventListener("click", () => void this.runSave());
  }

  private async runGenerate(generateBtn: HTMLButtonElement): Promise<void> {
    const description = this.descriptionEl?.value.trim();
    if (!description || this.isGenerating) return;

    this.isGenerating = true;
    generateBtn.disabled = true;
    generateBtn.textContent = "Generating\u2026";
    if (this.previewEl) this.previewEl.textContent = "Generating\u2026";
    if (this.templateEditorEl) this.templateEditorEl.value = "";
    if (this.saveBtnEl) this.saveBtnEl.disabled = true;

    try {
      const result = await generateText(
        TEMPLATE_ASSISTANT_SYSTEM_PROMPT,
        description,
        this.settings,
        this.resolvedModel,
        undefined,
        1024
      );
      this.generatedTemplate = result.text.trim();
      if (this.templateEditorEl) this.templateEditorEl.value = this.generatedTemplate;
      await this.renderPreview();
      if (this.saveBtnEl) this.saveBtnEl.disabled = false;
    } catch (err) {
      const errMsg = friendlyApiError(err) ?? (err instanceof Error ? err.message : String(err));
      if (this.previewEl) this.previewEl.textContent = `Error: ${errMsg}`;
    } finally {
      this.isGenerating = false;
      generateBtn.disabled = false;
      generateBtn.textContent = "Generate";
    }
  }

  private async renderPreview(): Promise<void> {
    if (!this.previewEl) return;
    const template = this.templateEditorEl?.value.trim() || this.generatedTemplate;
    if (!template) return;

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      this.previewEl.textContent = template;
      return;
    }

    try {
      const ctx = await assembleNoteContext(this.app, activeFile, this.settings);
      await populateLinkedNoteContent(this.app, ctx, 1000);
      const rendered = await substituteVariables(template, ctx);
      this.previewEl.textContent = rendered;
    } catch {
      this.previewEl.textContent = template;
    }
  }

  private async runSave(): Promise<void> {
    const template = this.templateEditorEl?.value.trim() || this.generatedTemplate;
    if (!template) return;
    new TemplateSaveNameModal(this.app, async (name) => {
      const folder = this.targetFolder || "Augment/templates";
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        try { await this.app.vault.createFolder(folder); } catch { /* already exists */ }
      }
      const path = `${folder}/${name}.md`;
      if (this.app.vault.getAbstractFileByPath(path)) {
        new Notice(`Template "${name}" already exists`);
        return;
      }
      await this.app.vault.create(path, buildTemplateFileContent({ name, description: "", system_prompt: null, body: template }));
      new Notice(`Template "${name}" saved`);
      this.onSave();
      this.close();
    }).open();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class TemplateSaveNameModal extends Modal {
  constructor(app: App, private onConfirm: (name: string) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Name your template" });
    let name = "";
    const setting = new Setting(contentEl)
      .setName("Template name")
      .addText((text) => {
        text.setPlaceholder("My template").onChange((val) => { name = val; });
        setTimeout(() => text.inputEl.focus(), 50);
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); void save(); }
        });
      });
    const save = async () => {
      const trimmed = name.trim();
      if (!trimmed) return;
      await this.onConfirm(trimmed);
      this.close();
    };
    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((btn) => btn.setButtonText("Save").setCta().onClick(save));
  }

  onClose(): void { this.contentEl.empty(); }
}
