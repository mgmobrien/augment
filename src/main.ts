import { addIcon, Editor, MarkdownView, Notice, Plugin, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { applyOutputFormat, bestModelByTier, bestModelId, buildSystemPrompt, buildUserMessage, fetchModels, friendlyApiError, generateText, logApiDiagnostics, ModelInfo, modelDisplayName, substituteVariables } from "./ai-client";
import { AgentSuggest } from "./agent-suggest";
import { InboxSuggest } from "./inbox-suggest";
import { ContextInspectorView, VIEW_TYPE_CONTEXT_INSPECTOR } from "./context-inspector-view";
import { AugmentSettingTab } from "./settings-tab";
import { getTemplateFiles, runGenerateTemplatesFlow, TemplatePicker, TemplatePreviewModal } from "./template-picker";
import { assembleNoteContext, assembleVaultContext, AugmentSettings, ContextEntry, DEFAULT_SETTINGS, populateLinkedNoteContent, SessionRecord, SpendData, TerminalOpenLocation } from "./vault-context";
import { TerminalView, VIEW_TYPE_TERMINAL, cleanupXtermStyle } from "./terminal-view";
import { TerminalManagerView, VIEW_TYPE_TERMINAL_MANAGER } from "./terminal-manager-view";
import { TerminalSwitcherModal } from "./terminal-switcher";
import { EditorView, keymap } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { SCAFFOLD_FOLDER, SCAFFOLD_TEMPLATES, SCAFFOLD_SKILLS_FOLDER, SCAFFOLD_SKILLS } from "./scaffold-data";
import { addSpinnerEffect, removeSpinnerEffect, spinnerField, addAgentWidgetEffect, removeAgentWidgetEffect, agentWidgetField } from "./editor-extensions";
import { TeamCreateSpawnEvent, RenameModal, InitTeamModal } from "./terminal-modals";

declare const __AUGMENT_BUILD_ID__: string;
declare const __AUGMENT_GIT_SHA__: string;

function buildWelcomeNoteContent(mod: string): string {
  return `# Get started with Augment

Augment adds AI-powered text generation and Claude Code terminal sessions to Obsidian. This note walks you through everything.

---

## 1. Add your API key

You need a console API key from [console.anthropic.com/settings/api-keys](https://console.anthropic.com/settings/api-keys) — not your Claude.ai login.

> [!warning] Claude Max/Pro subscriptions don't work here
> Anthropic prohibits OAuth tokens in third-party tools (Feb 2026). You need a pay-per-token key starting with \`sk-ant-api03-\`. Billing is separate from any subscription.

Open settings: **${mod}+,** → Augment in the left sidebar → Overview tab. Add your key there, then come back.

---

## 2. Generate (${mod}+Enter)

Augment reads your note title, frontmatter, the text above your cursor, and any linked notes — then continues from where your cursor is. Output goes directly below your cursor.

**Try it.** Put your cursor at the end of the line below and press ${mod}+Enter:

The most interesting thing about writing in plain text is

---

## 3. Template picker (${mod}+Shift+Enter)

Instead of free-form generation, templates run a specific prompt on your current note — useful for recurring tasks: summarise, extract action items, rewrite in a different register.

**Try it:** Press **${mod}+Shift+Enter** to open the template picker.

Templates are \`.md\` files in your templates folder (\`Augment/templates/\` by default). Configure the folder in Settings → Templates. Each template can define a custom system prompt via \`system_prompt:\` in its frontmatter.

---

## 4. Context inspector

The context inspector shows exactly what Augment sent to the AI: system prompt, this note's content, linked notes, and a token estimate per section. It updates live as you write.

**Open it:** Command palette → \`Augment: Open context inspector\`

The panel opens in your right sidebar. Use it to understand why the AI responded the way it did, or to check your context budget before generating.

---

## 5. Right-click menu

Right-clicking in any note gives you quick access without shortcuts:
- **Augment: Generate** — same as ${mod}+Enter
- **Augment: Generate from template…** — same as ${mod}+Shift+Enter

---

## 6. Claude Code terminal sessions

Augment hosts Claude Code agent sessions in a panel alongside your notes. Each session runs a full CC conversation with access to your vault.

**Set it up:** Settings → Terminal → follow the guided setup. Four steps, same on every platform: install Node.js, install Claude Code, sign in, configure vault.

---

*This note lives at \`Augment/Get started.md\`. Reopen it any time: command palette → \`Augment: Open welcome\`.*
`;
}

export default class AugmentTerminalPlugin extends Plugin {
  settings: AugmentSettings = { ...DEFAULT_SETTINGS };
  public availableModels: ModelInfo[] = [];
  public contextHistory: ContextEntry[] = [];
  public readonly buildId: string = __AUGMENT_BUILD_ID__;
  public readonly gitSha: string = __AUGMENT_GIT_SHA__;
  private recentTeamCreateSpawnSignatures: Map<string, number> = new Map();
  private calloutStyleEl: HTMLStyleElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private ribbonGenerateEl: HTMLElement | null = null;
  private ribbonTerminalEl: HTMLElement | null = null;
  private _tier1Registered = false;
  private _tier3Registered = false;
  public spendData: SpendData | null = null;
  private readonly SPEND_PATH = "augment-spend.json";
  private waitingBadgeEl: HTMLElement | null = null;
  private waitingCursor: number = 0;
  private activeGeneration: {
    abortController: AbortController;
    cmView: EditorView;
    insertPos: number;
  } | null = null;

  // Returns the actual model ID to use, resolving "auto" and tier aliases to the best available.
  public resolveModel(): string {
    switch (this.settings.model) {
      case "auto":         return bestModelId(this.availableModels) ?? "claude-opus-4-6";
      case "auto-opus":    return bestModelByTier(this.availableModels, "opus")   ?? "claude-opus-4-6";
      case "auto-sonnet":  return bestModelByTier(this.availableModels, "sonnet") ?? "claude-sonnet-4-6";
      case "auto-haiku":   return bestModelByTier(this.availableModels, "haiku")  ?? "claude-haiku-4-5-20251001";
      default:             return this.settings.model;
    }
  }

  // Display name for the resolved model — used in status bar and output formats.
  // Prefers curated local names over API-returned display_name (API may truncate, e.g. "Claude Opus 4" vs "Claude Opus 4.6").
  public resolveModelDisplayName(): string {
    const id = this.resolveModel();
    const localName = modelDisplayName(id);
    // modelDisplayName returns the id itself when not found — if it differs, we have a curated name.
    if (localName !== id) return localName;
    const found = this.availableModels.find(m => m.id === id);
    return found?.display_name ?? id;
  }

  /** Sync the `.augment-ribbon-colored` class with the current setting value. */
  public applyRibbonColoredClass(): void {
    if (!this.ribbonGenerateEl) return;
    if (this.settings.coloredRibbonIcon) {
      this.ribbonGenerateEl.addClass("augment-ribbon-colored");
    } else {
      this.ribbonGenerateEl.removeClass("augment-ribbon-colored");
    }
  }

  /** Swap the ribbon Generate button icon to match the current ribbonIcon setting. */
  public applyRibbonIcon(): void {
    if (!this.ribbonGenerateEl) return;
    // Call setIcon on the container element, not the inner .svg-icon span.
    // Calling it on the span causes the icon to revert when Obsidian refreshes the ribbon.
    setIcon(this.ribbonGenerateEl, this.settings.ribbonIcon || "augment-pyramid");
  }

  public refreshStatusBar(): void {
    this.ribbonGenerateEl?.removeClass("augment-ribbon-generating");
    this.ribbonGenerateEl?.removeClass("is-generating");
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    const sbIconEl = this.statusBarEl.createEl("span", { cls: "augment-sb-icon" });
    setIcon(sbIconEl, this.settings.ribbonIcon || "augment-pyramid");
    if (!this.settings.apiKey) {
      this.statusBarEl.createEl("span", { text: " Augment: API key needed" });
    } else {
      this.statusBarEl.createEl("span", { text: ` Augment: ${this.resolveModelDisplayName()}` });
    }
  }

  public getBuildFingerprint(): string {
    return `${this.buildId} (${this.gitSha})`;
  }

  private cancelGeneration(): void {
    const gen = this.activeGeneration;
    if (!gen) return;
    gen.abortController.abort();
    gen.cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
    // Restore cursor to the generation start position.
    gen.cmView.dispatch({ selection: EditorSelection.cursor(Math.min(gen.insertPos, gen.cmView.state.doc.length)) });
    this.activeGeneration = null;
    this.refreshStatusBar();
    console.log("[Augment] generation cancelled");
    new Notice("Augment: generation cancelled");
  }

  private showStatusBarGenerating(): void {
    if (this.statusBarEl) {
      this.statusBarEl.empty();
      const sbSpinner = this.statusBarEl.createEl("span", { cls: "augment-sb-spinner" });
      sbSpinner.createEl("span", { cls: "augment-sb-dot" });
      sbSpinner.createEl("span", { cls: "augment-sb-dot" });
      sbSpinner.createEl("span", { cls: "augment-sb-dot" });
      this.statusBarEl.createEl("span", { text: " Generating\u2026" });
    }
    this.ribbonGenerateEl?.addClass("augment-ribbon-generating");
    this.ribbonGenerateEl?.addClass("is-generating");
  }

  private triggerGenerate(editor: Editor): void {
    const cursor = editor.getCursor();
    const aboveCursor = editor.getRange({ line: 0, ch: 0 }, cursor);
    const promptText = aboveCursor.trim() || editor.getValue().trim();
    const ctx = assembleVaultContext(this.app, editor, this.settings);

    this.showStatusBarGenerating();
    if (this.settings.showGenerationToast) {
      const genNotice = new Notice("Generating…", 3000);
    }

    const isBlock = this.settings.outputFormat !== "plain";
    let insertPos: number;
    if (isBlock && cursor.ch > 0) {
      editor.replaceRange("\n", cursor);
      insertPos = editor.posToOffset({ line: cursor.line + 1, ch: 0 });
    } else {
      insertPos = editor.posToOffset(cursor);
    }

    const cmView = (editor as any).cm as EditorView;
    cmView.dispatch({ effects: addSpinnerEffect.of(insertPos), selection: EditorSelection.cursor(insertPos, 1) });

    const abortController = new AbortController();
    this.activeGeneration = { abortController, cmView, insertPos };

    void (async () => {
      try {
        await populateLinkedNoteContent(this.app, ctx);
        const resolvedModel = this.resolveModel();
        const resolvedModelName = this.resolveModelDisplayName();
        const { text: result, usage: genUsage } = await generateText(buildSystemPrompt(ctx, this.settings.systemPrompt || undefined, this.settings.workspaceScope, this.settings.defaultWorkingDirectory || undefined), promptText, this.settings, resolvedModel, abortController.signal);
        this.activeGeneration = null;
        void this.accumulateSpend(resolvedModel, genUsage);
        cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
        const formatted = applyOutputFormat(result, this.settings, resolvedModelName);
        const insertPosLine = editor.offsetToPos(insertPos);
        if (isBlock) {
          const withTrail = formatted + "\n\n";
          editor.replaceRange(withTrail, insertPosLine);
          const lines = withTrail.split("\n");
          editor.setCursor({ line: insertPosLine.line + lines.length - 1, ch: 0 });
        } else {
          editor.replaceRange(formatted, insertPosLine);
        }
        const entry: ContextEntry = {
          timestamp: Date.now(),
          noteName: ctx.title,
          model: resolvedModelName,
          systemPrompt: buildSystemPrompt(ctx, this.settings.systemPrompt || undefined, this.settings.workspaceScope, this.settings.defaultWorkingDirectory || undefined),
          userMessage: buildUserMessage(ctx, promptText),
        };
        this.pushContextHistory(entry);
        console.log("[Augment] generation done");
        const notice = new Notice("", 5000);
        notice.noticeEl.empty();
        notice.noticeEl.createEl("span", { text: "Augment: done" });
        notice.noticeEl.createEl("span", { cls: "augment-notice-sep", text: " \u00b7 " });
        const viewLink = notice.noticeEl.createEl("a", { cls: "augment-notice-action", text: "view context" });
        viewLink.href = "#";
        viewLink.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          notice.hide();
          this.openContextInspector();
        });
        if (!this.settings.hasGenerated) {
          this.settings.hasGenerated = true;
          await this.saveData(this.settings);
          this.registerTieredCommands();
        }
      } catch (err) {
        if (this.activeGeneration?.abortController === abortController) {
          // Aborted by cancel — already handled, just clean up.
          this.activeGeneration = null;
        }
        if (abortController.signal.aborted) return; // Cancel — no error notice.
        console.error("[Augment] generation failed", err);
        logApiDiagnostics(err, this.settings.apiKey, this.resolveModel());
        cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
        const errMsg = friendlyApiError(err) ?? (err instanceof Error ? err.message : String(err));
        new Notice(`Augment: ${errMsg}`);
      } finally {
        this.refreshStatusBar();
      }
    })();
  }

  private pushContextHistory(entry: ContextEntry): void {
    this.contextHistory.push(entry);
    if (this.contextHistory.length > 5) this.contextHistory.shift();
    this.app.workspace.trigger("augment:generation-complete");
  }

  private async loadAvailableModels(): Promise<void> {
    if (!this.settings.apiKey) return;
    this.availableModels = await fetchModels(this.settings.apiKey);
    // Refresh status bar in case "auto" now resolves to a fetched model name.
    this.refreshStatusBar();
  }

  async clearObsidianLinkHotkey(): Promise<void> {
    const CONFLICT_IDS = [
      "editor:cycle-list-checklist",
      "editor:open-link-in-new-leaf",
      "obsidian-textgenerator-plugin:generate-text",
      "obsidian-textgenerator-plugin:insert-generated-text-From-template",
    ];
    try {
      const hotkeyPath = ".obsidian/hotkeys.json";
      let hotkeys: Record<string, unknown> = {};
      try {
        const raw = await this.app.vault.adapter.read(hotkeyPath);
        hotkeys = JSON.parse(raw);
      } catch { /* file may not exist yet */ }
      // Capture originals before overwriting so restore is exact.
      const originals: Record<string, unknown> = {};
      for (const id of CONFLICT_IDS) {
        if (id in hotkeys) originals[id] = hotkeys[id];
        hotkeys[id] = [];
      }
      await this.app.vault.adapter.write(hotkeyPath, JSON.stringify(hotkeys, null, 2));
      (this.app as any).hotkeyManager?.load?.();
      this.settings.clearedLinkHotkey = true;
      this.settings.clearedHotkeyOriginals = originals;
      await this.saveData(this.settings);
    } catch (e) {
      console.warn("[Augment] could not clear link hotkey:", e);
    }
  }

  async restoreObsidianLinkHotkey(): Promise<void> {
    const CONFLICT_IDS = [
      "editor:cycle-list-checklist",
      "editor:open-link-in-new-leaf",
      "obsidian-textgenerator-plugin:generate-text",
      "obsidian-textgenerator-plugin:insert-generated-text-From-template",
    ];
    // Built-in default hotkeys for commands where we called removeDefaultHotkeys().
    // Must re-add these at runtime so Obsidian's binding works immediately.
    const BUILTIN_DEFAULTS: Record<string, Array<{ modifiers: string[]; key: string }>> = {
      "editor:open-link-in-new-leaf": [{ modifiers: ["Mod"], key: "Enter" }],
    };
    try {
      const hotkeyPath = ".obsidian/hotkeys.json";
      let hotkeys: Record<string, unknown> = {};
      try {
        const raw = await this.app.vault.adapter.read(hotkeyPath);
        hotkeys = JSON.parse(raw);
      } catch { /* file may not exist */ }
      const originals = this.settings.clearedHotkeyOriginals ?? {};
      for (const id of CONFLICT_IDS) {
        if (id in originals) {
          hotkeys[id] = originals[id]; // restore exact original value
        } else {
          delete hotkeys[id]; // wasn't customised before — remove Augment's entry
        }
      }
      await this.app.vault.adapter.write(hotkeyPath, JSON.stringify(hotkeys, null, 2));
      // Restore runtime defaults that were removed via removeDefaultHotkeys().
      const hm = (this.app as any).hotkeyManager;
      for (const [id, bindings] of Object.entries(BUILTIN_DEFAULTS)) {
        hm?.addDefaultHotkeys?.(id, bindings);
      }
      await hm?.load?.();
      this.settings.clearedLinkHotkey = false;
      this.settings.clearedHotkeyOriginals = {};
      await this.saveData(this.settings);
    } catch (e) {
      console.warn("[Augment] could not restore link hotkey:", e);
    }
  }

  private showHotkeyClaimedNotice(): void {
    const notice = new Notice("", 0);
    notice.noticeEl.empty();
    notice.noticeEl.createEl("span", { text: "Augment claimed Ctrl+Enter \u2014 " });
    const link = notice.noticeEl.createEl("a", { text: "Restore Obsidian\u2019s default", href: "#" });
    link.style.color = "var(--text-accent)";
    link.style.cursor = "pointer";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      notice.hide();
      (this.app as any).setting?.open?.();
      (this.app as any).setting?.openTabById?.("augment-terminal");
    });
  }

  private async scaffoldDefaultTemplates(): Promise<void> {
    const targetFolder = this.settings.templateFolder || SCAFFOLD_FOLDER;

    // Create folder if absent.
    if (!this.app.vault.getAbstractFileByPath(targetFolder)) {
      try { await this.app.vault.createFolder(targetFolder); } catch { /* already exists */ }
    }

    // Ensure templateFolder setting is saved.
    if (!this.settings.templateFolder) {
      this.settings.templateFolder = targetFolder;
      await this.saveData(this.settings);
    }

    // Write each default template if its file doesn't exist yet.
    // Never overwrite existing files — user edits are preserved.
    // New defaults added in future versions will be seeded into existing vaults.
    for (const [name, content] of SCAFFOLD_TEMPLATES) {
      const path = `${targetFolder}/${name}.md`;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        try { await this.app.vault.create(path, content); } catch { /* already exists */ }
      }
    }

    // Set templateFolder so the picker finds the scaffolded files.
    this.settings.templateFolder = targetFolder;
    await this.saveData(this.settings);
  }

  private async scaffoldDefaultSkills(): Promise<void> {
    // Create top-level folder if absent.
    if (!this.app.vault.getAbstractFileByPath(SCAFFOLD_SKILLS_FOLDER)) {
      try { await this.app.vault.createFolder(SCAFFOLD_SKILLS_FOLDER); } catch { /* already exists */ }
    }

    for (const [folderName, content] of SCAFFOLD_SKILLS) {
      const skillFolder = `${SCAFFOLD_SKILLS_FOLDER}/${folderName}`;
      if (!this.app.vault.getAbstractFileByPath(skillFolder)) {
        try { await this.app.vault.createFolder(skillFolder); } catch { /* already exists */ }
      }
      const skillPath = `${skillFolder}/SKILL.md`;
      if (!this.app.vault.getAbstractFileByPath(skillPath)) {
        try { await this.app.vault.create(skillPath, content); } catch { /* already exists */ }
      }
    }
  }

  async onload(): Promise<void> {
    // Register the System 3 pyramid icon: three dots (red top, blue bottom-left, green bottom-right).
    // Lucide-style: stroke outlines, currentColor, no fill. Three circles in pyramid.
    addIcon("augment-pyramid", `
      <circle cx="50" cy="18" r="13" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>
      <circle cx="18" cy="72" r="13" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>
      <circle cx="82" cy="72" r="13" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>
    `);

    console.log(`[augment] build ${this.getBuildFingerprint()}`);
    const raw = await this.loadData() as Record<string, unknown> | null;
    // Schema migration: strip keys removed in prior versions.
    // v0.0.4: useWsl, pythonPath; v0.0.7: s3Token, s3Email
    if (raw && typeof raw === "object") {
      delete raw["useWsl"];
      delete raw["pythonPath"];
      delete raw["s3Token"];
      delete raw["s3Email"];
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

    // Migrate legacy sidebar location values to their top/bottom variants.
    if (this.settings.defaultTerminalLocation === "sidebar-right") {
      this.settings.defaultTerminalLocation = "sidebar-right-bottom";
    } else if (this.settings.defaultTerminalLocation === "sidebar-left") {
      this.settings.defaultTerminalLocation = "sidebar-left-bottom";
    }

    // Migrate invalid ribbonIcon values. "settings" leaked from an old settings-ribbon button
    // that was removed. Any unrecognised value resets to the default pyramid.
    const VALID_RIBBON_ICONS = new Set([
      "augment-pyramid", "wand-2", "sparkles", "brain", "zap", "bot",
      "pencil", "type", "message-square", "cpu", "code-2", "terminal",
    ]);
    if (!VALID_RIBBON_ICONS.has(this.settings.ribbonIcon)) {
      this.settings.ribbonIcon = "augment-pyramid";
    }

    // Clear Obsidian's conflicting Cmd/Ctrl+Enter defaults.
    // Two mechanisms: (1) removeDefaultHotkeys on the runtime hotkey manager (immediate),
    // (2) write [] to hotkeys.json (persists across reloads for non-plugin built-ins).
    {
      const hm = (this.app as any).hotkeyManager;
      const RUNTIME_CONFLICTS = [
        "editor:open-link-in-new-leaf",
        "editor:cycle-list-checklist",
      ];
      for (const id of RUNTIME_CONFLICTS) {
        hm?.removeDefaultHotkeys?.(id);
      }
      const isFirst = !this.settings.clearedLinkHotkey;
      void this.clearObsidianLinkHotkey().then(() => {
        if (isFirst) this.showHotkeyClaimedNotice();
      });
    }

    // Fetch available models in the background — populates the model dropdown
    // and resolves "auto" to the best available model name in the status bar.
    void this.loadAvailableModels();

    this.calloutStyleEl = document.head.createEl("style");
    this.calloutStyleEl.id = "augment-callout-styles";
    this.calloutStyleEl.textContent = [
      `.callout[data-callout="ai"] { --callout-icon: bot; --callout-color: 139, 92, 246; }`,
      `.callout[data-callout="ai"] .callout-icon { display: flex !important; }`,
      `.callout[data-callout="ai"] .callout-title::before { content: "" !important; display: none !important; }`,
    ].join("\n");

    // Register views
    this.registerView(VIEW_TYPE_TERMINAL, (leaf) => {
      const view = new TerminalView(
        leaf,
        this.getPluginDir(),
        () => this.settings.shellPath,
        () => this.settings.defaultWorkingDirectory
      );
      view.onSessionExit = (name, status, startedAt, skillName) => {
        this.appendSessionRecord(name, status, startedAt, skillName);
      };
      view.onAutoRenameRequest = (excerpt: string) => {
        return Promise.resolve(this.deriveTerminalNameFromExcerpt(excerpt));
      };
      return view;
    });
    this.registerView(VIEW_TYPE_TERMINAL_MANAGER, (leaf) => {
      return new TerminalManagerView(leaf);
    });
    this.registerView(VIEW_TYPE_CONTEXT_INSPECTOR, (leaf) => {
      return new ContextInspectorView(leaf, this);
    });
    // Escape key cancels in-progress generation.
    const escapeKeymap = keymap.of([{
      key: "Escape",
      run: () => {
        if (this.activeGeneration) {
          this.cancelGeneration();
          return true;
        }
        return false;
      },
    }]);

    this.registerEditorExtension([spinnerField, agentWidgetField, escapeKeymap]);

    // Global cancel callback for the spinnerField's backspace detection.
    (globalThis as any).__augmentCancelGeneration = () => this.cancelGeneration();

    const agentSuggest = new AgentSuggest(this.app);
    this.registerEditorSuggest(agentSuggest);
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => agentSuggest.reload())
    );

    this.registerEditorSuggest(new InboxSuggest(this.app));

    // AI generation commands
    this.addCommand({
      id: "augment-generate",
      name: "Generate",
      hotkeys: [{ modifiers: ["Mod"], key: "Enter" }],
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          console.log("[Augment] no active note for generate");
          new Notice("Open a note to generate");
          return;
        }
        if (!this.settings.apiKey) {
          console.log("[Augment] API key required");
          const notice = new Notice("Augment: API key required \u2014 click to open settings", 0);
          notice.noticeEl.style.cursor = "pointer";
          notice.noticeEl.addEventListener("click", () => {
            notice.hide();
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
          });
          return;
        }
        this.triggerGenerate(view.editor);
      },
    });

    this.addCommand({
      id: "augment-generate-from-template",
      name: "Generate from template",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }],
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          console.log("[Augment] no active note for generate-from-template");
          new Notice("Open a note to generate");
          return;
        }
        const editor = view.editor;
        if (!this.settings.apiKey) {
          console.log("[Augment] API key required");
          const notice = new Notice("Augment: API key required \u2014 click to open settings", 0);
          notice.noticeEl.style.cursor = "pointer";
          notice.noticeEl.addEventListener("click", () => {
            notice.hide();
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
          });
          return;
        }
        if (!this.settings.templateFolder) {
          console.log("[Augment] no template folder set");
          const notice = new Notice("Augment: no template folder set \u2014 click to configure", 0);
          notice.noticeEl.style.cursor = "pointer";
          notice.noticeEl.addEventListener("click", () => {
            notice.hide();
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
          });
          return;
        }
        const files = getTemplateFiles(this.app, this.settings.templateFolder);
        if (files.length === 0) {
          console.log("[Augment] no templates found in", this.settings.templateFolder);
          new Notice(`Augment: no templates found in ${this.settings.templateFolder}`);
          return;
        }
        const cursor = editor.getCursor();
        const ctx = assembleVaultContext(this.app, editor, this.settings);
        new TemplatePicker(this.app, files, async (templateFile) => {
          const templateContent = await this.app.vault.read(templateFile);

          // Read system_prompt override and output routing from template frontmatter.
          const templateFm = this.app.metadataCache.getFileCache(templateFile)?.frontmatter;
          const systemPromptOverride = typeof templateFm?.system_prompt === "string"
            ? templateFm.system_prompt
            : undefined;
          // target: "cursor" (default) | "clipboard" | "file" | "frontmatter"
          const targetMode: string = typeof templateFm?.target === "string" ? templateFm.target : "cursor";
          const targetFilePath: string | null = typeof templateFm?.target_file === "string" ? templateFm.target_file : null;
          const targetField: string | null = typeof templateFm?.target_field === "string" ? templateFm.target_field : null;

          // Lazy full-content reads — only when the template actually uses the variables.
          if (templateContent.includes("{{note_content}}")) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) ctx.content = await this.app.vault.read(activeFile);
          }
          if (templateContent.includes("{{linked_notes_full}}") || templateContent.includes("linked_notes_array")) {
            for (const note of ctx.linkedNotes) {
              const file = this.app.vault.getFiles().find((f) => f.basename === note.title);
              if (file) {
                try { note.content = await this.app.vault.read(file); } catch { /* skip */ }
              }
            }
          }

          const rendered = await substituteVariables(templateContent, ctx);

          const runGenerate = async () => {
            this.showStatusBarGenerating();

            const isCursorMode = targetMode === "cursor";
            const isBlock = this.settings.outputFormat !== "plain";
            let insertPos = 0;
            const cmView = (editor as any).cm as EditorView;

            if (isCursorMode) {
              if (isBlock && cursor.ch > 0) {
                editor.replaceRange("\n", cursor);
                insertPos = editor.posToOffset({ line: cursor.line + 1, ch: 0 });
              } else {
                insertPos = editor.posToOffset(cursor);
              }
              cmView.dispatch({ effects: addSpinnerEffect.of(insertPos), selection: EditorSelection.cursor(insertPos, 1) });
            }

            const abortController = new AbortController();
            this.activeGeneration = { abortController, cmView, insertPos };

            try {
              const resolvedModel = this.resolveModel();
              const resolvedModelName = this.resolveModelDisplayName();
              const { text: result, usage: genUsage } = await generateText(buildSystemPrompt(ctx, systemPromptOverride, this.settings.workspaceScope, this.settings.defaultWorkingDirectory || undefined), rendered, this.settings, resolvedModel, abortController.signal);
              this.activeGeneration = null;
              void this.accumulateSpend(resolvedModel, genUsage);
              if (isCursorMode) cmView.dispatch({ effects: removeSpinnerEffect.of(null) });

              // Route output
              if (targetMode === "clipboard") {
                await navigator.clipboard.writeText(result);
                new Notice("Augment: copied to clipboard", 5000);
              } else if (targetMode === "file" && targetFilePath) {
                const destFile = this.app.vault.getAbstractFileByPath(targetFilePath);
                if (destFile instanceof TFile) {
                  const prev = await this.app.vault.read(destFile);
                  await this.app.vault.modify(destFile, prev + "\n\n" + result);
                } else {
                  const parentFolder = targetFilePath.includes("/")
                    ? targetFilePath.slice(0, targetFilePath.lastIndexOf("/"))
                    : null;
                  if (parentFolder && !this.app.vault.getAbstractFileByPath(parentFolder)) {
                    try { await this.app.vault.createFolder(parentFolder); } catch { /* ignore */ }
                  }
                  await this.app.vault.create(targetFilePath, result);
                }
                const shortName = targetFilePath.split("/").pop() ?? targetFilePath;
                new Notice(`Augment: appended to ${shortName}`, 5000);
              } else if (targetMode === "frontmatter" && targetField) {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                  await this.app.fileManager.processFrontMatter(activeFile, (fm) => {
                    fm[targetField!] = result;
                  });
                }
                new Notice(`Augment: wrote to frontmatter.${targetField}`, 5000);
              } else {
                // cursor (default)
                const formatted = applyOutputFormat(result, this.settings, resolvedModelName);
                const insertPosLine = editor.offsetToPos(insertPos);
                if (isBlock) {
                  const withTrail = formatted + "\n\n";
                  editor.replaceRange(withTrail, insertPosLine);
                  const lines = withTrail.split("\n");
                  editor.setCursor({ line: insertPosLine.line + lines.length - 1, ch: 0 });
                } else {
                  editor.replaceRange(formatted, insertPosLine);
                }
                console.log("[Augment] template generation done");
                const notice = new Notice("", 5000);
                notice.noticeEl.empty();
                notice.noticeEl.createEl("span", { text: "Augment: done" });
                notice.noticeEl.createEl("span", { cls: "augment-notice-sep", text: " \u00b7 " });
                const viewLink = notice.noticeEl.createEl("a", { cls: "augment-notice-action", text: "view context" });
                viewLink.href = "#";
                viewLink.addEventListener("click", (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  notice.hide();
                  this.openContextInspector();
                });
              }

              // Common post-generation tracking (all targets)
              const entry: ContextEntry = {
                timestamp: Date.now(),
                noteName: ctx.title,
                model: resolvedModelName,
                systemPrompt: buildSystemPrompt(ctx, systemPromptOverride, this.settings.workspaceScope, this.settings.defaultWorkingDirectory || undefined),
                userMessage: rendered,
              };
              this.pushContextHistory(entry);
              if (!this.settings.hasGenerated) {
                this.settings.hasGenerated = true;
                await this.saveData(this.settings);
                this.registerTieredCommands();
              }
              if (!this.settings.hasUsedTemplate) {
                this.settings.hasUsedTemplate = true;
                await this.saveData(this.settings);
              }
            } catch (err) {
              if (this.activeGeneration?.abortController === abortController) {
                this.activeGeneration = null;
              }
              if (abortController.signal.aborted) return;
              console.error("[Augment] template generation failed", err);
              logApiDiagnostics(err, this.settings.apiKey, this.resolveModel());
              if (isCursorMode) cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
              const errMsg = friendlyApiError(err) ?? (err instanceof Error ? err.message : String(err));
              new Notice(`Augment: ${errMsg}`);
            } finally {
              this.refreshStatusBar();
            }
          };

          if (!this.settings.showTemplatePreview) {
            await runGenerate();
            return;
          }

          new TemplatePreviewModal(this.app, rendered, ctx, async (skipPreviewInFuture) => {
            if (skipPreviewInFuture) {
              this.settings.showTemplatePreview = false;
              await this.saveData(this.settings);
            }
            await runGenerate();
          }).open();
        }).open();
      },
    });

    this.addCommand({
      id: "generate-templates-from-folder",
      name: "Generate templates from folder\u2026",
      callback: () => {
        if (!this.settings.apiKey) {
          new Notice("Augment: add an API key in Settings \u2192 Augment first");
          return;
        }
        runGenerateTemplatesFlow(this.app, this.settings, this.resolveModel());
      },
    });

    this.addCommand({
      id: "augment-open-settings",
      name: "Open settings",
      callback: () => {
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById("augment-terminal");
      },
    });

    this.addCommand({
      id: "open-welcome",
      name: "Open welcome",
      callback: () => {
        void this.createAndOpenWelcomeNote();
      },
    });

    this.addSettingTab(new AugmentSettingTab(this.app, this));

    // Status bar — model name, click to open settings
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.style.cursor = "pointer";
    this.statusBarEl.addEventListener("click", () => {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById("augment-terminal");
    });
    this.refreshStatusBar();

    // First-load welcome note — shown once, only when not yet configured
    if (!this.settings.apiKey && !this.settings.hasSeenWelcome) {
      this.settings.hasSeenWelcome = true;
      void this.saveData(this.settings);
      this.app.workspace.onLayoutReady(() => {
        void this.createAndOpenWelcomeNote();
      });
    }

    // Right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        const menuIcon = this.settings.ribbonIcon || "augment-pyramid";
        if (!this.settings.apiKey) {
          menu.addItem((item) => {
            item
              .setTitle("Augment: add API key to get started \u2192")
              .setIcon(menuIcon)
              .onClick(() => {
                (this.app as any).setting.open();
                (this.app as any).setting.openTabById("augment-terminal");
              });
          });
          return;
        }
        menu.addItem((item) => {
          item
            .setTitle("Augment: Generate")
            .setIcon(menuIcon)
            .onClick(() => {
              (this.app as any).commands.executeCommandById("augment-terminal:augment-generate");
            });
        });
        menu.addItem((item) => {
          item
            .setTitle("Augment: Generate from template\u2026")
            .setIcon(menuIcon)
            .onClick(() => {
              (this.app as any).commands.executeCommandById("augment-terminal:augment-generate-from-template");
            });
        });
      })
    );

    // Ribbon: terminal — added only after terminal setup completes (tier 3).
    this.addTerminalRibbonIfNeeded();

    // Ribbon: configurable icon → generate AI text
    this.ribbonGenerateEl = this.addRibbonIcon(this.settings.ribbonIcon || "augment-pyramid", "Generate", () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) {
        new Notice("Open a note to generate");
        return;
      }
      this.triggerGenerate(view.editor);
    });
    this.ribbonGenerateEl.addClass("augment-ribbon-generate");
    this.applyRibbonColoredClass();

    // Default open command — uses defaultTerminalLocation setting.
    this.addCommand({
      id: "open-terminal",
      name: "Open terminal",
      hotkeys: [{ modifiers: ["Ctrl"], key: "t" }],
      callback: () => {
        this.openTerminalAt(this.settings.defaultTerminalLocation);
      },
    });

    // Tier 3 commands (location variants, manager, switcher) register lazily
    // via registerTieredCommands() when terminalSetupDone becomes true.

    // Team scaffolding
    this.addCommand({
      id: "init-team",
      name: "Init team \u2014 scaffold .parts/ in a project",
      callback: () => {
        new InitTeamModal(this.app, false).open();
      },
    });

    this.addCommand({
      id: "refresh-team-skills",
      name: "Refresh team skills \u2014 update .parts/skills/ with latest defaults",
      callback: () => {
        new InitTeamModal(this.app, true).open();
      },
    });

    this.registerEvent(
      (this.app.workspace as any).on("augment-terminal:teamcreate", (event: TeamCreateSpawnEvent) => {
        void this.handleTeamCreateSpawn(event);
      })
    );

    // Attention queue — badge (always visible), command registered lazily at tier 3.
    this.waitingBadgeEl = this.addStatusBarItem();
    this.waitingBadgeEl.style.cursor = "pointer";
    this.waitingBadgeEl.style.display = "none";
    this.waitingBadgeEl.addEventListener("click", () => this.jumpToNextWaiting());

    this.registerEvent(
      this.app.workspace.on("augment-terminal:changed", () => this.refreshAttentionBadge())
    );

    this.app.workspace.onLayoutReady(() => {
      void this.loadSpendData().then(() => {
        // Migration: infer tier flags from existing data for users who installed before
        // progressive disclosure was implemented.
        let migrated = false;
        if (!this.settings.terminalSetupDone && (this.settings.sessionHistory?.length ?? 0) > 0) {
          this.settings.terminalSetupDone = true;
          migrated = true;
        }
        if (!this.settings.hasGenerated && this.spendData && Object.keys(this.spendData.byModel).length > 0) {
          this.settings.hasGenerated = true;
          migrated = true;
        }
        if (migrated) {
          void this.saveData(this.settings);
        }
        this.registerTieredCommands();
        this.addTerminalRibbonIfNeeded();
      });
      // Scaffold defaults on first install — deferred so vault I/O doesn't
      // compete with Obsidian's core startup sequence.
      void this.scaffoldDefaultTemplates();
      void this.scaffoldDefaultSkills();
      this.refreshAttentionBadge();
      // Auto-open Terminal Manager in left sidebar after reload.
      // Obsidian persists sidebar state, so check if one already exists.
      if (this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL_MANAGER).length === 0) {
        const leaf = this.app.workspace.getLeftLeaf(false);
        if (leaf) {
          leaf.setViewState({ type: VIEW_TYPE_TERMINAL_MANAGER, active: false });
        }
      }
      // Auto-open Context Inspector in right sidebar on first install.
      // Also clean up duplicate leaves that may have been saved from prior sessions.
      const inspectorLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CONTEXT_INSPECTOR);
      if (inspectorLeaves.length === 0) {
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
          leaf.setViewState({ type: VIEW_TYPE_CONTEXT_INSPECTOR, active: false });
        }
      } else if (inspectorLeaves.length > 1) {
        for (let i = 1; i < inspectorLeaves.length; i++) {
          inspectorLeaves[i].detach();
        }
      }
    });

  }

  // Lazily register commands that should only appear after the user reaches a tier.
  // Safe to call multiple times — flags prevent double-registration.
  public registerTieredCommands(): void {
    if (this.settings.hasGenerated && !this._tier1Registered) {
      this._tier1Registered = true;
      // Tier 1: generate-from-template is already registered eagerly (complex callback).
      // view-context registered at tier 1 only:
      this.addCommand({
        id: "augment-view-context",
        name: "Open context inspector",
        callback: () => { this.openContextInspector(); },
      });
    }

    if (this.settings.terminalSetupDone && !this._tier3Registered) {
      this._tier3Registered = true;

      // 7 explicit location variants
      this.addCommand({
        id: "open-terminal-tab",
        name: "Open terminal in new tab",
        callback: () => { this.openTerminalAt("tab"); },
      });
      this.addCommand({
        id: "open-terminal-right",
        name: "Open terminal to the right",
        callback: () => { this.openTerminalAt("split-right"); },
      });
      this.addCommand({
        id: "open-terminal-down",
        name: "Open terminal below",
        callback: () => { this.openTerminalAt("split-down"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar-right-top",
        name: "Open terminal in right sidebar (top)",
        callback: () => { this.openTerminalAt("sidebar-right-top"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar-right-bottom",
        name: "Open terminal in right sidebar (bottom)",
        callback: () => { this.openTerminalAt("sidebar-right-bottom"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar-left-top",
        name: "Open terminal in left sidebar (top)",
        callback: () => { this.openTerminalAt("sidebar-left-top"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar-left-bottom",
        name: "Open terminal in left sidebar (bottom)",
        callback: () => { this.openTerminalAt("sidebar-left-bottom"); },
      });

      // Legacy compat aliases (preserve saved hotkeys)
      this.addCommand({
        id: "open-terminal-sidebar-right",
        name: "Open terminal in right sidebar (bottom, legacy)",
        callback: () => { this.openTerminalAt("sidebar-right-bottom"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar-left",
        name: "Open terminal in left sidebar (bottom, legacy)",
        callback: () => { this.openTerminalAt("sidebar-left-bottom"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar",
        name: "Open terminal in sidebar (right)",
        callback: () => { this.openTerminalAt("sidebar-right"); },
      });
      this.addCommand({
        id: "open-terminal-grid",
        name: "Open terminal grid (2x2)",
        callback: () => { this.openTerminalGrid(); },
      });

      // Terminal manager
      this.addCommand({
        id: "open-terminal-manager",
        name: "Show terminal manager",
        hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "t" }],
        callback: () => { this.openTerminalManager(); },
      });

      // Terminal switcher
      this.addCommand({
        id: "switch-terminal",
        name: "Switch terminal",
        callback: () => { new TerminalSwitcherModal(this.app).open(); },
      });

      // Rename terminal
      this.addCommand({
        id: "rename-terminal",
        name: "Rename terminal",
        callback: () => {
          const view = this.app.workspace.getActiveViewOfType(TerminalView);
          if (view) { new RenameModal(this.app, view).open(); }
        },
      });

      // Attention queue command
      this.addCommand({
        id: "jump-to-next-waiting-session",
        name: "Jump to next waiting session",
        callback: () => this.jumpToNextWaiting(),
      });
    }
  }

  // Add the terminal ribbon icon if terminalSetupDone and not already added.
  public addTerminalRibbonIfNeeded(): void {
    if (this.settings.terminalSetupDone && !this.ribbonTerminalEl) {
      this.ribbonTerminalEl = this.addRibbonIcon("terminal", "Open terminal", () => {
        this.openTerminalAt(this.settings.defaultTerminalLocation);
      });
    }
  }

  async onunload(): Promise<void> {
    delete (globalThis as any).__augmentCancelGeneration;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
    // Do not detach VIEW_TYPE_TERMINAL_MANAGER or VIEW_TYPE_CONTEXT_INSPECTOR on unload.
    // Obsidian persists their sidebar placement across reloads. Detaching here would
    // remove the saved position and force a re-place to the default location every time.
    cleanupXtermStyle();
    this.calloutStyleEl?.remove();
    this.calloutStyleEl = null;
  }

  private getWaitingLeaves(): WorkspaceLeaf[] {
    const leaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view?.getViewType?.() === VIEW_TYPE_TERMINAL) {
        const view = leaf.view as any;
        if (typeof view.getStatus === "function" && view.getStatus() === "waiting") {
          leaves.push(leaf);
        }
      }
    });
    // Sort oldest-waiting first: smallest lastActivityMs = waited longest.
    leaves.sort((a, b) => {
      const aMs = typeof (a.view as any).getLastActivityMs === "function" ? (a.view as any).getLastActivityMs() : 0;
      const bMs = typeof (b.view as any).getLastActivityMs === "function" ? (b.view as any).getLastActivityMs() : 0;
      return aMs - bMs;
    });
    return leaves;
  }

  private refreshAttentionBadge(): void {
    if (!this.waitingBadgeEl) return;
    const waiting = this.getWaitingLeaves();
    if (waiting.length === 0) {
      this.waitingBadgeEl.style.display = "none";
      this.waitingCursor = 0;
    } else {
      this.waitingBadgeEl.style.display = "";
      this.waitingBadgeEl.setText(`⚡ ${waiting.length}`);
      this.waitingBadgeEl.setAttribute("aria-label", `${waiting.length} session${waiting.length !== 1 ? "s" : ""} waiting for input`);
    }
  }

  private jumpToNextWaiting(): void {
    const waiting = this.getWaitingLeaves();
    if (waiting.length === 0) return;
    this.waitingCursor = this.waitingCursor % waiting.length;
    const target = waiting[this.waitingCursor];
    this.waitingCursor = (this.waitingCursor + 1) % waiting.length;
    this.app.workspace.setActiveLeaf(target, { focus: true });
  }

  private getPluginDir(): string {
    return (this.app.vault.adapter as any).basePath + "/.obsidian/plugins/augment-terminal";
  }

  private async createAndOpenWelcomeNote(): Promise<void> {
    const folderPath = "Augment";
    const filePath = "Augment/Get started.md";

    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    if (!this.app.vault.getAbstractFileByPath(filePath)) {
      const mod = process.platform === "darwin" ? "Cmd" : "Ctrl";
      await this.app.vault.create(filePath, buildWelcomeNoteContent(mod));
    }

    const file = this.app.vault.getAbstractFileByPath(filePath) as TFile;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
  }

  // Open a terminal at the user-configured default location (or a fixed location
  // for explicit-location commands). Sidebar locations fall back to a new tab if
  // the workspace API returns null for the sidebar leaf.
  private async openTerminalAt(
    location: TerminalOpenLocation = "tab",
    options?: { name?: string; active?: boolean; reveal?: boolean }
  ): Promise<TerminalView> {
    const { workspace } = this.app;
    const desiredName = options?.name?.trim();
    const active = options?.active ?? true;
    const reveal = options?.reveal ?? true;

    let leaf: WorkspaceLeaf;
    if (location === "split-right") {
      leaf = workspace.getLeaf("split", "vertical");
    } else if (location === "split-down") {
      leaf = workspace.getLeaf("split", "horizontal");
    } else if (location === "sidebar-right" || location === "sidebar-right-bottom") {
      // getRightLeaf(true) splits the sidebar, placing the new leaf below the existing one.
      // getRightLeaf(false) reuses/returns the existing top leaf — wrong for "bottom".
      leaf = workspace.getRightLeaf(true) ?? workspace.getLeaf("tab");
    } else if (location === "sidebar-right-top") {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
    } else if (location === "sidebar-left" || location === "sidebar-left-bottom") {
      leaf = workspace.getLeftLeaf(true) ?? workspace.getLeaf("tab");
    } else if (location === "sidebar-left-top") {
      leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf("tab");
    } else {
      leaf = workspace.getLeaf("tab");
    }

    await leaf.setViewState({
      type: VIEW_TYPE_TERMINAL,
      active,
      state: desiredName ? { name: desiredName } : undefined,
    });

    if (desiredName) {
      const view = leaf.view as Partial<TerminalView>;
      if (typeof view.setName === "function") {
        view.setName(desiredName);
      }
    }

    if (reveal) {
      workspace.revealLeaf(leaf);
    }

    return leaf.view as TerminalView;
  }


  private async openTerminalSidebar(): Promise<TerminalView | null> {
    const { workspace } = this.app;
    const leaf = workspace.getRightLeaf(false);

    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL,
        active: true,
      });
      workspace.revealLeaf(leaf);
      return leaf.view as TerminalView;
    }
    return null;
  }

  private async openTerminalManager(): Promise<void> {
    const { workspace } = this.app;

    // Reuse existing manager leaf
    const existing = workspace.getLeavesOfType(VIEW_TYPE_TERMINAL_MANAGER);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL_MANAGER,
        active: true,
      });
      workspace.revealLeaf(leaf);
    }
  }

  private async openTerminalGrid(): Promise<void> {
    const { workspace } = this.app;

    const topLeft = workspace.getLeaf("tab");
    await topLeft.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    const topRight = (workspace as any).createLeafBySplit(topLeft, "vertical");
    await topRight.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    const bottomLeft = (workspace as any).createLeafBySplit(topLeft, "horizontal");
    await bottomLeft.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    const bottomRight = (workspace as any).createLeafBySplit(topRight, "horizontal");
    await bottomRight.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    workspace.revealLeaf(topLeft);
  }

  private async handleTeamCreateSpawn(event: TeamCreateSpawnEvent): Promise<void> {
    const members = Array.from(
      new Set(
        (event.members ?? [])
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      )
    );
    if (members.length === 0) return;

    const signature = `${event.team ?? ""}|${members.slice().sort().join(",")}`;
    const now = Date.now();
    const previous = this.recentTeamCreateSpawnSignatures.get(signature);
    if (previous && now - previous < 15_000) {
      return;
    }
    this.recentTeamCreateSpawnSignatures.set(signature, now);
    if (this.recentTeamCreateSpawnSignatures.size > 150) {
      for (const [key, ts] of this.recentTeamCreateSpawnSignatures) {
        if (now - ts > 60_000) {
          this.recentTeamCreateSpawnSignatures.delete(key);
        }
      }
    }

    // Filter out members that already have a terminal.
    const toSpawn = members.filter((name) => !this.hasTerminalNamed(name));
    if (toSpawn.length === 0) return;

    // Layout: first subagent opens in a vertical split (right column),
    // subsequent subagents stack below it via createLeafBySplit.
    // This mirrors the tmux split-pane layout: leader left, subagents right.
    let columnLeaf: WorkspaceLeaf | null = null;
    for (const member of toSpawn) {
      let leaf: WorkspaceLeaf;
      if (columnLeaf === null) {
        leaf = this.app.workspace.getLeaf("split", "vertical");
        columnLeaf = leaf;
      } else {
        leaf = (this.app.workspace as any).createLeafBySplit(columnLeaf, "horizontal");
      }

      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL,
        active: false,
        state: { name: member },
      });

      const view = leaf.view as Partial<TerminalView>;
      if (typeof view.setName === "function") {
        view.setName(member);
      }
    }
  }

  public insertAgentWidget(editor: Editor, pos: { line: number; ch: number }, name: string): void {
    const cmView = (editor as any).cm as EditorView;
    const offset = editor.posToOffset(pos);
    cmView.dispatch({ effects: addAgentWidgetEffect.of({ pos: offset, name }) });
  }

  public async launchSkillSession(file: TFile, skillName: string, editor?: Editor): Promise<void> {
    const vaultBase = (this.app.vault.adapter as any).basePath as string;
    const absolutePath = `${vaultBase}/${file.path}`;

    // Build a claude shell command: claude "/{skillName} on {absoluteFilePath}"
    // Escape double quotes in the path to avoid shell breakage.
    const safePath = absolutePath.replace(/"/g, '\\"');
    const claudeCmd = `claude "/${skillName} on ${safePath}"\n`;

    // Open in right sidebar without stealing focus from the note.
    const terminalView = await this.openTerminalSidebar();
    if (!terminalView) return;

    // Mark as skill session immediately — green steady dot in terminal manager.
    terminalView.markSkillRunning();
    terminalView.setSkillName(skillName);

    // Shell needs ~1500ms to initialize before we can write to it.
    setTimeout(() => {
      terminalView.write(claudeCmd);
    }, 1500);

    // Remove the inline widget silently when the terminal process exits.
    if (editor) {
      const cmView = (editor as any).cm as EditorView;
      const ref = this.app.workspace.on("augment-terminal:changed", () => {
        if (terminalView.getStatus() === "exited") {
          this.app.workspace.offref(ref);
          try {
            cmView.dispatch({ effects: removeAgentWidgetEffect.of(null) });
          } catch {
            // Editor may have been closed before the process exited — ignore.
          }
        }
      });
    }
  }

  async loadSpendData(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(this.SPEND_PATH);
      this.spendData = JSON.parse(raw) as SpendData;
      if (!this.spendData.byModel) this.spendData.byModel = {};
    } catch {
      this.spendData = { byModel: {} };
    }
  }

  private async accumulateSpend(modelId: string, usage: { input_tokens: number; output_tokens: number }): Promise<void> {
    if (!this.spendData) this.spendData = { byModel: {} };
    if (!this.spendData.since) this.spendData.since = Date.now();
    const entry = this.spendData.byModel[modelId] ?? { inputTokens: 0, outputTokens: 0, generations: 0 };
    entry.inputTokens += usage.input_tokens;
    entry.outputTokens += usage.output_tokens;
    entry.generations += 1;
    this.spendData.byModel[modelId] = entry;
    try {
      await this.app.vault.adapter.write(this.SPEND_PATH, JSON.stringify(this.spendData, null, 2));
    } catch { /* non-fatal */ }
  }

  async resetSpendData(): Promise<void> {
    this.spendData = { byModel: {}, since: Date.now() };
    try {
      await this.app.vault.adapter.write(this.SPEND_PATH, JSON.stringify(this.spendData, null, 2));
    } catch { /* non-fatal */ }
  }

  private appendSessionRecord(name: string, status: "exited" | "crashed", startedAt: number, skillName?: string): void {
    const record: SessionRecord = {
      id: `${startedAt}-${Math.random().toString(36).slice(2)}`,
      name,
      skillName,
      status,
      startedAt,
      closedAt: Date.now(),
    };
    if (!Array.isArray(this.settings.sessionHistory)) {
      this.settings.sessionHistory = [];
    }
    this.settings.sessionHistory.push(record);
    if (this.settings.sessionHistory.length > 200) {
      this.settings.sessionHistory = this.settings.sessionHistory.slice(-200);
    }
    void this.saveData(this.settings);
  }

  public async openTerminalNamed(name: string): Promise<void> {
    await this.openTerminalAt("tab", { name });
  }

  private sanitizeTerminalName(raw: string): string | null {
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    return cleaned || null;
  }

  // Local fallback so auto-rename works without custom hooks or API success.
  private deriveTerminalNameFromExcerpt(excerpt: string): string | null {
    const lines = excerpt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const userTurns: string[] = [];
    for (const line of lines) {
      if (line.startsWith("❯")) {
        const text = line.replace(/^❯\s*/, "").trim();
        if (text) userTurns.push(text);
      }
    }

    const source = userTurns.slice(-3).join(" ") || lines.slice(-20).join(" ");
    if (!source) return null;

    const STOP_WORDS = new Set([
      "the", "and", "for", "with", "that", "this", "from", "what", "when", "where",
      "which", "who", "your", "have", "will", "would", "could", "should", "about",
      "into", "them", "they", "dont", "doesnt", "cant", "isnt", "lets", "discussion",
      "discuss", "thread", "session", "please", "help", "talk", "why", "how", "bad",
      "good", "like", "love", "dont", "not",
    ]);

    const words = source
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));

    const unique: string[] = [];
    for (const word of words) {
      if (unique.includes(word)) continue;
      unique.push(word);
      if (unique.length >= 4) break;
    }

    if (unique.length === 0) return null;
    return this.sanitizeTerminalName(unique.join("-"));
  }

  public openContextInspector(): void {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      leaf.setViewState({ type: VIEW_TYPE_CONTEXT_INSPECTOR, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  public async openFocusedTerminal(): Promise<TerminalView> {
    return this.openTerminalAt("tab", { active: true });
  }

  public deleteSessionRecord(id: string): void {
    this.settings.sessionHistory = (this.settings.sessionHistory ?? []).filter(r => r.id !== id);
    void this.saveData(this.settings);
    this.app.workspace.trigger("augment-terminal:changed");
  }

  private hasTerminalNamed(name: string): boolean {
    const target = name.trim().toLowerCase();
    if (!target) return false;

    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    for (const leaf of leaves) {
      const view = leaf.view as Partial<TerminalView>;
      const viewName = typeof view.getName === "function" ? view.getName().trim() : "";
      if (viewName.toLowerCase() === target) {
        return true;
      }

      const leafAny = leaf as any;
      const stateName = leafAny.getViewState?.()?.state?.name;
      if (typeof stateName === "string" && stateName.trim().toLowerCase() === target) {
        return true;
      }
    }

    return false;
  }
}

