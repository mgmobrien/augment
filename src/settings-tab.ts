import { App, MarkdownView, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import AugmentTerminalPlugin from "./main";
import { AugmentSettings, ContextEntry } from "./vault-context";
import { buildSystemPrompt, buildUserMessage, modelDisplayName } from "./ai-client";
import { assembleVaultContext } from "./vault-context";
import { ContextInspectorModal } from "./context-inspector";

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
      text: "Vault-aware AI generation for Obsidian",
    });

    // ── Tab nav ──────────────────────────────────────────────
    const tabNav = containerEl.createEl("div", { cls: "augment-tab-nav" });
    const overviewTab = tabNav.createEl("button", { cls: "augment-tab is-active", text: "Overview" });
    const generateTab = tabNav.createEl("button", { cls: "augment-tab", text: "Generate" });
    const contextTab  = tabNav.createEl("button", { cls: "augment-tab", text: "Context" });

    // ── Panes ────────────────────────────────────────────────
    const overviewPane = containerEl.createEl("div", { cls: "augment-tab-pane" });
    const generatePane = containerEl.createEl("div", { cls: "augment-tab-pane" });
    const contextPane  = containerEl.createEl("div", { cls: "augment-tab-pane" });
    generatePane.style.display = "none";
    contextPane.style.display  = "none";

    const tabs = [
      { btn: overviewTab, pane: overviewPane },
      { btn: generateTab, pane: generatePane },
      { btn: contextTab,  pane: contextPane  },
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

    // Input refs — populated below when the Settings are created
    let apiKeyInputEl: HTMLInputElement | undefined;
    let templateFolderInputEl: HTMLInputElement | undefined;

    const jumpToTab = (targetBtn: HTMLElement, targetPane: HTMLElement) => {
      tabs.forEach(({ btn: b, pane: p }) => { b.removeClass("is-active"); p.style.display = "none"; });
      targetBtn.addClass("is-active");
      targetPane.style.display = "";
    };

    // Onboarding checklist card
    const statusCard = overviewPane.createEl("div", { cls: "augment-onboarding-card" });

    type OnboardingStep = {
      label: string;
      done: boolean;
      optional: boolean;
      cta: string | null;
      hotkey: string | null;
      onCta: (() => void) | null;
    };

    const renderSetupCard = () => {
      statusCard.empty();
      if (this.plugin.settings.setupCardDismissed) return;

      const header = statusCard.createEl("div", { cls: "augment-onboarding-header" });
      header.createEl("span", { cls: "augment-onboarding-title", text: "Get started" });
      const dismissBtn = header.createEl("button", { cls: "augment-onboarding-dismiss", text: "\u00d7" });
      dismissBtn.addEventListener("click", async () => {
        this.plugin.settings.setupCardDismissed = true;
        await this.plugin.saveData(this.plugin.settings);
        statusCard.empty();
      });

      const steps: OnboardingStep[] = [
        {
          label: "Add your API key",
          done: !!this.plugin.settings.apiKey,
          optional: false,
          cta: "Add key",
          hotkey: null,
          onCta: () => {
            jumpToTab(generateTab, generatePane);
            setTimeout(() => apiKeyInputEl?.focus(), 50);
          },
        },
        {
          label: "Generate text for the first time",
          done: this.plugin.settings.hasGenerated,
          optional: false,
          cta: null,
          hotkey: process.platform === "darwin" ? "\u2318\u21a9" : "Ctrl+\u21a9",
          onCta: null,
        },
        {
          label: "Set up templates",
          done: !!this.plugin.settings.templateFolder,
          optional: true,
          cta: "Set folder",
          hotkey: null,
          onCta: () => {
            jumpToTab(contextTab, contextPane);
            setTimeout(() => templateFolderInputEl?.focus(), 50);
          },
        },
      ];

      for (const step of steps) {
        const row = statusCard.createEl("div", {
          cls: ["augment-onboarding-step", step.done ? "is-done" : "", step.optional ? "is-optional" : ""].join(" ").trim(),
        });
        row.createEl("span", { cls: "augment-onboarding-check", text: step.done ? "\u2713" : "\u00b7" });
        const labelEl = row.createEl("span", { cls: "augment-onboarding-label" });
        labelEl.setText(step.label + (step.optional ? " (optional)" : ""));
        if (!step.done) {
          if (step.hotkey) {
            row.createEl("kbd", { cls: "augment-onboarding-hotkey", text: step.hotkey });
          } else if (step.cta && step.onCta) {
            const ctaEl = row.createEl("a", { cls: "augment-onboarding-cta", text: step.cta + " \u2192" });
            ctaEl.href = "#";
            ctaEl.addEventListener("click", (e) => { e.preventDefault(); step.onCta!(); });
          }
        }
      }
    };

    renderSetupCard();
    overviewTab.addEventListener("click", renderSetupCard);

    const previewBtn = overviewPane.createEl("button", {
      cls: "mod-cta augment-ctx-preview-btn",
      text: "Preview context for current note",
    });
    previewBtn.addEventListener("click", () => {
      const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (!activeView) {
        new Notice("Open a note to preview context");
        return;
      }
      const ctx = assembleVaultContext(this.plugin.app, activeView.editor, this.plugin.settings);
      const entry: ContextEntry = {
        timestamp: 0,
        noteName: ctx.title,
        model: this.plugin.resolveModelDisplayName(),
        systemPrompt: buildSystemPrompt(ctx),
        userMessage: "[your prompt would go here]",
      };
      new ContextInspectorModal(this.plugin.app, [entry], 0).open();
    });

    overviewPane.createEl("p", {
      cls: "augment-overview-intro",
      text: "Augment generates text inline using Claude, with context drawn from your current note — title, frontmatter, everything you\u2019ve written above your cursor, and linked notes.",
    });

    const howEl = overviewPane.createEl("div", { cls: "augment-overview-how" });
    howEl.createEl("div", { cls: "augment-overview-how-title", text: "How it works" });
    const steps = [
      "Position your cursor where you want output to appear.",
      "Press Mod+Enter (or right-click → Augment: Generate).",
      "A loading indicator appears while Claude generates.",
      "The result is inserted at your cursor in the chosen format.",
    ];
    const ol = howEl.createEl("ol", { cls: "augment-overview-steps" });
    for (const step of steps) {
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
      { label: "Set your API key", tab: generateTab, pane: generatePane },
      { label: "Choose a model", tab: generateTab, pane: generatePane },
      { label: "Configure output format", tab: generateTab, pane: generatePane },
      { label: "Set template folder", tab: contextTab, pane: contextPane },
    ];
    for (const { label, tab, pane } of items) {
      const li = linkList.createEl("li");
      const a = li.createEl("a", { cls: "augment-overview-link", text: label });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        tabs.forEach(({ btn: b, pane: p }) => {
          b.removeClass("is-active");
          p.style.display = "none";
        });
        tab.addClass("is-active");
        pane.style.display = "";
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

    // Secondary slot: heading level or callout type, placeholder otherwise.
    // Wrapped in .dropdown so Obsidian renders the native chevron.
    const secondaryWrapper = formatSetting.controlEl.createEl("div", {
      cls: "dropdown augment-format-secondary",
    });
    secondaryWrapper.style.marginLeft = "8px";
    const secondarySelect = secondaryWrapper.createEl("select") as HTMLSelectElement;

    // Tertiary slot: expanded/collapsed for callout, placeholder otherwise.
    const tertiaryWrapper = formatSetting.controlEl.createEl("div", {
      cls: "dropdown augment-format-tertiary",
    });
    tertiaryWrapper.style.marginLeft = "6px";
    const tertiarySelect = tertiaryWrapper.createEl("select") as HTMLSelectElement;

    const updateSecondarySlot = (format: string) => {
      // secondary
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

      // tertiary
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

    new Setting(generatePane)
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

    // WSL terminal setting — only relevant on Windows
    if (process.platform === "win32") {
      new Setting(generatePane)
        .setName("Run terminal via WSL")
        .setDesc(
          "Spawn the terminal PTY bridge through WSL (Windows Subsystem for Linux) instead of native Python. " +
          "Required on Windows — Python\u2019s pty module is Unix-only. " +
          "Requires WSL installed with python3 available in the default distro."
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

    // ── Context pane ─────────────────────────────────────────
    contextPane.createEl("p", {
      cls: "augment-context-intro",
      text: "Augment sends everything in the current note above your cursor, along with the note title, frontmatter, and linked note summaries. If you have text selected, the selection is used instead of the above-cursor context.",
    });

    new Setting(contextPane)
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
          });
      });

    new Setting(contextPane)
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

    new Setting(contextPane)
      .setName("Context limit")
      .setDesc("Maximum characters of context sent per generation (measured in tokens; 1 token \u2248 4 characters). The default of 2000 tokens (~8000 characters) fits most notes. Raise this if you have long notes or many linked notes and want to include more context.")
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
  }
}
