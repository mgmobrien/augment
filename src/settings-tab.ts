import { App, MarkdownView, Notice, PluginSettingTab, Setting, TFile, TFolder, setIcon } from "obsidian";
import AugmentTerminalPlugin from "./main";
import { AugmentSettings, assembleVaultContext } from "./vault-context";
import { modelDisplayName } from "./ai-client";
import { ContextInspectorModal } from "./context-inspector";

const TEMPLATE_SCAFFOLD = `---
name:
description:
---
Your task instruction here.

{{note_content}}
`;

const BUILTIN_CALLOUT_TYPES = [
  "note", "abstract", "info", "todo", "tip", "success",
  "question", "warning", "failure", "danger", "bug", "example", "quote",
].sort();

function detectCalloutTypes(): string[] {
  const custom = new Set<string>();
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules || [])) {
          for (const match of rule.cssText.matchAll(/\[data-callout="([^"]+)"\]/g)) {
            const t = match[1];
            if (t !== "ai" && !BUILTIN_CALLOUT_TYPES.includes(t)) custom.add(t);
          }
        }
      } catch { /* cross-origin sheet */ }
    }
  } catch { /* browser restriction */ }
  return ["ai", ...BUILTIN_CALLOUT_TYPES, ...Array.from(custom).sort()];
}

export class AugmentSettingTab extends PluginSettingTab {
  plugin: AugmentTerminalPlugin;

  constructor(app: App, plugin: AugmentTerminalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("augment-settings-container");

    // ── Header ──────────────────────────────────────────────
    const header = containerEl.createEl("div", { cls: "augment-settings-header" });
    const iconEl = header.createEl("div", { cls: "augment-settings-header-icon" });
    setIcon(iconEl, "radio-tower");
    const wordmark = header.createEl("div", { cls: "augment-settings-header-text" });
    wordmark.createEl("div", { cls: "augment-settings-wordmark", text: "Augment" });
    wordmark.createEl("div", {
      cls: "augment-settings-tagline",
      text: "In-editor continuation and a terminal system for Claude Code.",
    });

    // ── Tab nav ──────────────────────────────────────────────
    const tabNav = containerEl.createEl("div", { cls: "augment-tab-nav" });
    const overviewTab  = tabNav.createEl("button", { cls: "augment-tab is-active", text: "Overview" });
    const generateTab  = tabNav.createEl("button", { cls: "augment-tab", text: "Generate" });
    const templatesTab = tabNav.createEl("button", { cls: "augment-tab", text: "Templates" });
    const terminalTab  = tabNav.createEl("button", { cls: "augment-tab", text: "Terminal" });

    // ── Panes ────────────────────────────────────────────────
    const overviewPane  = containerEl.createEl("div", { cls: "augment-tab-pane" });
    const generatePane  = containerEl.createEl("div", { cls: "augment-tab-pane" });
    const templatesPane = containerEl.createEl("div", { cls: "augment-tab-pane" });
    const terminalPane  = containerEl.createEl("div", { cls: "augment-tab-pane" });
    generatePane.style.display  = "none";
    templatesPane.style.display = "none";
    terminalPane.style.display  = "none";

    const tabs = [
      { btn: overviewTab,  pane: overviewPane  },
      { btn: generateTab,  pane: generatePane  },
      { btn: templatesTab, pane: templatesPane },
      { btn: terminalTab,  pane: terminalPane  },
    ];

    tabs.forEach(({ btn, pane }) => {
      btn.addEventListener("click", () => {
        tabs.forEach(({ btn: b, pane: p }) => {
          b.removeClass("is-active");
          p.style.display = "none";
        });
        btn.addClass("is-active");
        pane.style.display = "";
      });
    });

    // ── Overview pane ────────────────────────────────────────

    // Input refs — populated below
    let apiKeyInputEl: HTMLInputElement | undefined;
    let templateFolderInputEl: HTMLInputElement | undefined;

    const jumpToTab = (targetBtn: HTMLElement, targetPane: HTMLElement) => {
      tabs.forEach(({ btn: b, pane: p }) => { b.removeClass("is-active"); p.style.display = "none"; });
      targetBtn.addClass("is-active");
      targetPane.style.display = "";
    };

    // Onboarding checklist card
    const statusCard = overviewPane.createEl("div", { cls: "augment-onboarding-card" });

    const renderSetupCard = () => {
      statusCard.empty();
      if (this.plugin.settings.setupCardDismissed) return;

      const header = statusCard.createEl("div", { cls: "augment-onboarding-header" });
      header.createEl("span", { cls: "augment-onboarding-title", text: "Get started" });
      const dismissBtn = header.createEl("button", { cls: "augment-onboarding-dismiss clickable-icon" });
      setIcon(dismissBtn, "x");
      dismissBtn.addEventListener("click", async () => {
        this.plugin.settings.setupCardDismissed = true;
        await this.plugin.saveData(this.plugin.settings);
        statusCard.empty();
      });

      const steps = [
        {
          label: "Add your API key",
          done: !!this.plugin.settings.apiKey,
          hotkey: null as string | null,
          onClick: () => {
            jumpToTab(generateTab, generatePane);
            setTimeout(() => apiKeyInputEl?.focus(), 50);
          },
        },
        {
          label: "Generate text for the first time",
          done: this.plugin.settings.hasGenerated,
          hotkey: process.platform === "darwin" ? "\u2318\u21a9" : "Ctrl+\u21a9",
          onClick: () => {
            new Notice(process.platform === "darwin" ? "Press \u2318\u21a9 to generate in any note" : "Press Ctrl+Enter to generate in any note");
          },
        },
        {
          label: "Run a template for the first time",
          done: this.plugin.settings.hasUsedTemplate,
          hotkey: process.platform === "darwin" ? "\u2318\u21e7\u21a9" : "Ctrl+Shift+\u21a9",
          onClick: () => {
            jumpToTab(templatesTab, templatesPane);
            setTimeout(() => templateFolderInputEl?.focus(), 50);
          },
        },
      ];

      for (const step of steps) {
        const row = statusCard.createEl("div", {
          cls: "augment-onboarding-step" + (step.done ? " is-done" : ""),
        });
        row.createEl("span", { cls: "augment-onboarding-check", text: step.done ? "\u2713" : "\u00b7" });
        const labelEl = row.createEl("a", { cls: "augment-onboarding-label", text: step.label });
        labelEl.href = "#";
        labelEl.addEventListener("click", (e) => { e.preventDefault(); step.onClick(); });
        if (step.hotkey) {
          row.createEl("kbd", { cls: "augment-onboarding-hotkey", text: step.hotkey });
        }
      }
    };

    renderSetupCard();
    overviewTab.addEventListener("click", renderSetupCard);

    const previewBtn = overviewPane.createEl("button", {
      cls: "augment-ctx-preview-btn",
      text: "Preview context for current note",
    });
    previewBtn.addEventListener("click", () => {
      const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (!activeView) {
        new Notice("Open a note to preview context");
        return;
      }
      const ctx = assembleVaultContext(this.plugin.app, activeView.editor, this.plugin.settings);
      new ContextInspectorModal(this.plugin.app, ctx).open();
    });

    overviewPane.createEl("p", {
      cls: "augment-overview-intro",
      text: "Augment is designed for high-speed, in-editor continuation while also providing a deep integrated terminal system for running agents like Claude Code. Generate inline with Mod+Enter \u2014 context comes from your note title, frontmatter, everything above your cursor, and linked notes.",
    });

    const howEl = overviewPane.createEl("div", { cls: "augment-overview-how" });
    howEl.createEl("div", { cls: "augment-overview-how-title", text: "How it works" });
    const howSteps = [
      "Position your cursor where you want output to appear.",
      "Press Mod+Enter (or right-click → Augment: Generate).",
      "A loading indicator appears while Claude generates.",
      "The result is inserted at your cursor in the chosen format.",
    ];
    const ol = howEl.createEl("ol", { cls: "augment-overview-steps" });
    for (const step of howSteps) {
      ol.createEl("li", { text: step });
    }

    const mockEl = overviewPane.createEl("div", { cls: "augment-overview-mock" });
    mockEl.createEl("div", { cls: "augment-overview-mock-label", text: "Example output (Callout format)" });
    mockEl.createEl("pre", {
      cls: "augment-overview-mock-code",
      text: `> [!ai]+ Claude Haiku 4.5\n>\n> Your generated text appears here,\n> inline in the document.`,
    });

    const linksEl = overviewPane.createEl("div", { cls: "augment-overview-links" });
    linksEl.createEl("div", { cls: "augment-overview-links-title", text: "Quick start" });
    const linkList = linksEl.createEl("ul", { cls: "augment-overview-link-list" });
    const items = [
      { label: "Set your API key",       tab: generateTab,  pane: generatePane  },
      { label: "Choose a model",         tab: generateTab,  pane: generatePane  },
      { label: "Configure output format", tab: generateTab,  pane: generatePane  },
      { label: "Manage templates",       tab: templatesTab, pane: templatesPane },
    ];
    for (const { label, tab, pane } of items) {
      const li = linkList.createEl("li");
      const a = li.createEl("a", { cls: "augment-overview-link", text: label });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        jumpToTab(tab, pane);
      });
    }

    // ── Generate pane ────────────────────────────────────────
    const apiKeySetting = new Setting(generatePane)
      .setName("API key")
      .addText((text) => {
        apiKeyInputEl = text.inputEl;
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });
    apiKeySetting.descEl.appendChild(
      createFragment((frag) => {
        frag.appendText("Anthropic API key. ");
        const a = frag.createEl("a", {
          text: "Get your API key",
          href: "https://platform.claude.com/settings/keys",
        });
        a.target = "_blank";
        a.rel = "noopener";
      })
    );

    const FALLBACK_MODELS = [
      { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
    ];
    const modelList = this.plugin.availableModels.length > 0
      ? this.plugin.availableModels
      : FALLBACK_MODELS;

    new Setting(generatePane)
      .setName("Model")
      .setDesc("Claude model to use for generation. Auto selects the best available model.")
      .addDropdown((drop) => {
        drop.addOption("auto", "Auto (best available)");
        for (const m of modelList) {
          drop.addOption(m.id, m.display_name);
        }
        drop
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.refreshStatusBar();
          });
      });

    const calloutTypes = detectCalloutTypes();

    const formatSetting = new Setting(generatePane)
      .setName("Output format")
      .setDesc("How generated text is inserted into the editor.")
      .addDropdown((drop) => {
        drop
          .addOption("plain", "Plain text")
          .addOption("codeblock", "Code block")
          .addOption("blockquote", "Blockquote")
          .addOption("heading", "Heading")
          .addOption("callout", "Callout box")
          .setValue(this.plugin.settings.outputFormat)
          .onChange(async (value) => {
            this.plugin.settings.outputFormat = value as AugmentSettings["outputFormat"];
            await this.plugin.saveData(this.plugin.settings);
            updateSecondarySlot(value);
          });
      });

    const secondaryWrapper = formatSetting.controlEl.createEl("div", {
      cls: "dropdown augment-format-secondary",
    });
    secondaryWrapper.style.marginLeft = "8px";
    const secondarySelect = secondaryWrapper.createEl("select") as HTMLSelectElement;

    const tertiaryWrapper = formatSetting.controlEl.createEl("div", {
      cls: "dropdown augment-format-tertiary",
    });
    tertiaryWrapper.style.marginLeft = "6px";
    const tertiarySelect = tertiaryWrapper.createEl("select") as HTMLSelectElement;

    const updateSecondarySlot = (format: string) => {
      secondarySelect.empty();
      if (format === "heading") {
        secondaryWrapper.removeClass("is-placeholder");
        secondarySelect.disabled = false;
        for (let i = 1; i <= 7; i++) {
          const opt = secondarySelect.createEl("option", { value: String(i), text: `H${i}` });
          if (i === this.plugin.settings.headingLevel) opt.selected = true;
        }
      } else if (format === "callout") {
        secondaryWrapper.removeClass("is-placeholder");
        secondarySelect.disabled = false;
        for (const t of calloutTypes) {
          const opt = secondarySelect.createEl("option", { value: t, text: t });
          if (t === this.plugin.settings.calloutType) opt.selected = true;
        }
      } else {
        secondaryWrapper.addClass("is-placeholder");
        secondarySelect.disabled = true;
        secondarySelect.createEl("option", { value: "", text: "\u2014" });
      }

      tertiarySelect.empty();
      if (format === "callout") {
        tertiaryWrapper.removeClass("is-placeholder");
        tertiarySelect.disabled = false;
        tertiarySelect.createEl("option", { value: "expanded", text: "Expanded" });
        tertiarySelect.createEl("option", { value: "collapsed", text: "Collapsed" });
        tertiarySelect.value = this.plugin.settings.calloutExpanded !== false ? "expanded" : "collapsed";
      } else {
        tertiaryWrapper.addClass("is-placeholder");
        tertiarySelect.disabled = true;
        tertiarySelect.createEl("option", { value: "", text: "\u2014" });
      }
    };

    updateSecondarySlot(this.plugin.settings.outputFormat);

    secondarySelect.addEventListener("change", async () => {
      const format = this.plugin.settings.outputFormat;
      if (format === "heading") {
        this.plugin.settings.headingLevel = parseInt(secondarySelect.value, 10);
      } else if (format === "callout") {
        this.plugin.settings.calloutType = secondarySelect.value;
      }
      await this.plugin.saveData(this.plugin.settings);
    });

    tertiarySelect.addEventListener("change", async () => {
      this.plugin.settings.calloutExpanded = tertiarySelect.value === "expanded";
      await this.plugin.saveData(this.plugin.settings);
    });

    // ── Context section (within Generate pane) ────────────────
    generatePane.createDiv({ cls: "augment-section-label", text: "Context" });
    generatePane.createEl("p", {
      cls: "augment-context-intro",
      text: "Augment sends note title, frontmatter, above-cursor text, and linked notes.",
    });

    new Setting(generatePane)
      .setName("Linked notes in context")
      .setDesc("Number of wikilinked notes to include as context (0\u201310). For each linked note, Augment sends the note title and its frontmatter \u2014 not the note body. Set to 0 to disable linked note context.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.max = "10";
        text
          .setPlaceholder("3")
          .setValue(String(this.plugin.settings.linkedNoteCount))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 0 && n <= 10) {
              this.plugin.settings.linkedNoteCount = n;
              await this.plugin.saveData(this.plugin.settings);
            }
          });
      });

    new Setting(generatePane)
      .setName("Context limit")
      .setDesc("Maximum context sent per generation (measured in tokens; 1 token \u2248 4 characters). Default 2000 tokens fits most notes.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text
          .setPlaceholder("2000")
          .setValue(String(this.plugin.settings.maxContextTokens))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.maxContextTokens = n;
              await this.plugin.saveData(this.plugin.settings);
            }
          });
      });

    // ── Templates pane ───────────────────────────────────────
    templatesPane.createEl("p", {
      cls: "augment-context-intro",
      text: "Templates let you define reusable prompts for common generation tasks. Each template is a Markdown file in your templates folder. Use Cmd+Shift+Enter (or right-click \u2192 Run template) to pick and run a template on the current note.",
    });

    // Variable reference table.
    const varRef = templatesPane.createDiv({ cls: "augment-variable-ref" });
    varRef.createDiv({ cls: "augment-section-label", text: "Variables" });
    const varTable = varRef.createEl("table", { cls: "augment-var-table" });
    const varTbody = varTable.createEl("tbody");
    const varRows = [
      { name: "{{title}}",              desc: "Note filename (without extension)" },
      { name: "{{selection}}",          desc: "Current editor selection" },
      { name: "{{context}}",            desc: "~50 lines around the cursor" },
      { name: "{{note_content}}",       desc: "Full note text" },
      { name: "{{linked_notes}}",       desc: "Linked notes: title + frontmatter" },
      { name: "{{linked_notes_full}}", desc: "Linked notes with full body content \u2014 can be large" },
      { name: "{{frontmatter.KEY}}",   desc: "Any frontmatter value \u2014 e.g. {{frontmatter.status}}" },
    ];
    for (const v of varRows) {
      const tr = varTbody.createEl("tr");
      const td1 = tr.createEl("td");
      td1.createEl("code", { text: v.name });
      tr.createEl("td", { text: v.desc });
    }

    // Template folder setting.
    new Setting(templatesPane)
      .setName("Template folder")
      .setDesc("Vault path to folder containing .md prompt templates")
      .addText((text) => {
        templateFolderInputEl = text.inputEl;
        text
          .setPlaceholder("Augment/templates")
          .setValue(this.plugin.settings.templateFolder)
          .onChange(async (value) => {
            this.plugin.settings.templateFolder = value;
            await this.plugin.saveData(this.plugin.settings);
            renderTemplateList();
          });
      });

    // "Reveal in file explorer" link.
    const folderLinkEl = templatesPane.createDiv({ cls: "augment-folder-link" });
    const openFolderEl = folderLinkEl.createEl("a", {
      cls: "augment-folder-open",
      text: "Reveal in file explorer \u2197",
    });
    openFolderEl.href = "#";
    openFolderEl.addEventListener("click", (e) => {
      e.preventDefault();
      const folderPath = this.plugin.settings.templateFolder;
      const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
      if (folder) {
        const fe = (this.plugin.app as any).internalPlugins?.getPluginById("file-explorer")?.instance;
        fe?.revealInFolder?.(folder);
      } else {
        new Notice(`Folder "${folderPath}" not found \u2014 check the path above`);
      }
    });

    // Show template preview toggle — moved from Generate tab.
    new Setting(templatesPane)
      .setName("Show template preview")
      .setDesc("Preview the rendered prompt before generating from a template")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showTemplatePreview)
          .onChange(async (value) => {
            this.plugin.settings.showTemplatePreview = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    // Template list container.
    templatesPane.createDiv({ cls: "augment-template-section-header" })
      .createDiv({ cls: "augment-section-label", text: "Templates in folder" });
    const templateListEl = templatesPane.createDiv({ cls: "augment-template-list" });

    const renderTemplateList = () => {
      templateListEl.empty();

      const folderPath = this.plugin.settings.templateFolder;
      const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);

      if (!folder || !(folder instanceof TFolder)) {
        templateListEl.createDiv({
          cls: "augment-template-empty",
          text: "No templates found. Check the folder path above or create a template.",
        });
        return;
      }

      const files = folder.children
        .filter((f): f is TFile => f instanceof TFile && f.extension === "md")
        .sort((a, b) => a.basename.localeCompare(b.basename));

      if (files.length === 0) {
        templateListEl.createDiv({
          cls: "augment-template-empty",
          text: "No templates in this folder.",
        });
        return;
      }

      for (const file of files) {
        const meta = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        const name = meta?.name || file.basename;
        const desc = meta?.description || "";

        const row = templateListEl.createDiv({ cls: "augment-template-row" });
        const info = row.createDiv({ cls: "augment-template-row-info" });
        info.createSpan({ cls: "augment-template-name", text: name });
        if (desc) {
          info.createSpan({ cls: "augment-template-desc", text: desc });
        }

        const openBtn = row.createEl("button", {
          cls: "augment-template-open clickable-icon",
          text: "Open \u2197",
        });
        openBtn.addEventListener("click", () => {
          this.plugin.app.workspace.openLinkText(file.basename, "", false);
        });
      }
    };

    renderTemplateList();

    // "+ New template" button.
    const newTemplateBtn = templatesPane.createEl("button", {
      cls: "augment-template-new-btn",
      text: "+ New template",
    });
    newTemplateBtn.addEventListener("click", async () => {
      const folder = this.plugin.settings.templateFolder || "Augment/templates";
      const newPath = `${folder}/New template.md`;
      try {
        const file = await this.plugin.app.vault.create(newPath, TEMPLATE_SCAFFOLD);
        await this.plugin.app.workspace.getLeaf().openFile(file);
        renderTemplateList();
      } catch {
        const existing = this.plugin.app.vault.getAbstractFileByPath(newPath);
        if (existing instanceof TFile) {
          await this.plugin.app.workspace.getLeaf().openFile(existing);
        } else {
          new Notice("Could not create template");
        }
      }
    });

    // Format guide.
    const formatGuide = templatesPane.createDiv({ cls: "augment-template-format" });
    formatGuide.createDiv({ cls: "augment-section-label", text: "Template format" });
    formatGuide.createEl("pre", {
      cls: "augment-format-example",
      text: "---\nname: Template name\ndescription: Shown in picker\nsystem_prompt: |\n  You are Gus, a thinking partner embedded in this vault.\n  [optional \u2014 omit to use the default system prompt]\n---\nYour task instruction here.\n\n{{note_content}}",
    });

    // ── Terminal pane ────────────────────────────────────────
    terminalPane.createEl("p", {
      cls: "augment-context-intro",
      text: "Settings for the integrated terminal. Most users won't need to change these.",
    });

    if (process.platform === "win32") {
      new Setting(terminalPane)
        .setName("Run terminal via WSL")
        .setDesc(
          "Spawn the PTY bridge through WSL instead of native Python. Required on Windows. " +
          "WSL must be installed with python3 available in the default distro."
        )
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.useWsl)
            .onChange(async (value) => {
              this.plugin.settings.useWsl = value;
              await this.plugin.saveData(this.plugin.settings);
            });
        });
    }

    new Setting(terminalPane)
      .setName("Python path")
      .setDesc("Path to python3 binary for the PTY bridge. Leave blank to use system default.")
      .addText((text) => {
        text
          .setPlaceholder("python3")
          .setValue(this.plugin.settings.pythonPath)
          .onChange(async (value) => {
            this.plugin.settings.pythonPath = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(terminalPane)
      .setName("Shell")
      .setDesc("Shell to launch in new terminals. Leave blank to use the system default.")
      .addText((text) => {
        text
          .setPlaceholder(process.platform === "darwin" ? "/bin/zsh" : "$SHELL")
          .setValue(this.plugin.settings.shellPath)
          .onChange(async (value) => {
            this.plugin.settings.shellPath = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(terminalPane)
      .setName("Default working directory")
      .setDesc("Starting directory for new terminals. Leave blank to use the vault root.")
      .addText((text) => {
        text
          .setPlaceholder("(vault root)")
          .setValue(this.plugin.settings.defaultWorkingDirectory)
          .onChange(async (value) => {
            this.plugin.settings.defaultWorkingDirectory = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    // WSL doc link
    const termFooter = terminalPane.createDiv({ cls: "augment-folder-link" });
    const wslLink = termFooter.createEl("a", {
      cls: "augment-folder-open",
      text: "WSL setup guide \u2197",
      href: "https://github.com/mgmobrien/augment/blob/main/WSL.md",
    });
    wslLink.target = "_blank";
    wslLink.rel = "noopener";
  }
}
