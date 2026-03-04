import { App, DropdownComponent, PluginSettingTab, Setting, setIcon } from "obsidian";
import AugmentTerminalPlugin from "./main";
import { AugmentSettings } from "./vault-context";

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
    overviewPane.createEl("p", {
      cls: "augment-overview-intro",
      text: "Augment generates text inline using Claude, with context drawn from your current note — title, frontmatter, the text around your cursor, and linked notes.",
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
    new Setting(generatePane)
      .setName("API key")
      .setDesc("Anthropic API key")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(generatePane)
      .setName("Model")
      .setDesc("Claude model to use for generation")
      .addDropdown((drop) => {
        drop
          .addOption("claude-haiku-4-5-20251001", "Claude Haiku 4.5 (fast)")
          .addOption("claude-sonnet-4-6", "Claude Sonnet 4.6")
          .addOption("claude-opus-4-6", "Claude Opus 4.6")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.refreshStatusBar();
          });
      });

    let calloutTypeSetting: Setting;
    let calloutExpandedSetting: Setting;
    let headingDropComponent: DropdownComponent | null = null;

    const isCallout = () => this.plugin.settings.outputFormat === "callout";
    const formatDescDefault = "How generated text is inserted into the editor.";
    const formatDescCallout = "Wrap output in an Obsidian callout box. Set the callout type below \u2193";

    const formatSetting = new Setting(generatePane)
      .setName("Output format")
      .setDesc(isCallout() ? formatDescCallout : formatDescDefault)
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
            if (headingDropComponent) {
              headingDropComponent.selectEl.style.display = value === "heading" ? "" : "none";
            }
            calloutTypeSetting.settingEl.style.display = value === "callout" ? "" : "none";
            calloutExpandedSetting.settingEl.style.display = value === "callout" ? "" : "none";
            formatSetting.setDesc(value === "callout" ? formatDescCallout : formatDescDefault);
          });
      })
      .addDropdown((drop) => {
        headingDropComponent = drop;
        for (let i = 1; i <= 7; i++) drop.addOption(String(i), `H${i}`);
        drop.setValue(String(this.plugin.settings.headingLevel));
        drop.selectEl.style.marginLeft = "8px";
        drop.selectEl.style.display = this.plugin.settings.outputFormat === "heading" ? "" : "none";
        drop.onChange(async (value) => {
          this.plugin.settings.headingLevel = parseInt(value, 10);
          await this.plugin.saveData(this.plugin.settings);
        });
      });

    const calloutTypes = detectCalloutTypes();
    calloutTypeSetting = new Setting(generatePane)
      .setName("Callout type")
      .setDesc("Obsidian callout type for generated output")
      .addDropdown((drop) => {
        for (const t of calloutTypes) drop.addOption(t, t);
        const current = calloutTypes.includes(this.plugin.settings.calloutType)
          ? this.plugin.settings.calloutType
          : "ai";
        drop.setValue(current);
        drop.onChange(async (value) => {
          this.plugin.settings.calloutType = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      });
    calloutTypeSetting.settingEl.style.display = isCallout() ? "" : "none";

    calloutExpandedSetting = new Setting(generatePane)
      .setName("Callout default state")
      .setDesc("Whether generated callouts are expanded or collapsed by default")
      .addDropdown((drop) => {
        drop
          .addOption("expanded", "Expanded")
          .addOption("collapsed", "Collapsed")
          .setValue(this.plugin.settings.calloutExpanded !== false ? "expanded" : "collapsed")
          .onChange(async (value) => {
            this.plugin.settings.calloutExpanded = value === "expanded";
            await this.plugin.saveData(this.plugin.settings);
          });
      });
    calloutExpandedSetting.settingEl.style.display = isCallout() ? "" : "none";

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
      text: "Each generation sends the model: your note\u2019s title and frontmatter, the text around your cursor (or your selection if you have one selected), and a configurable number of linked notes. For linked notes, only the note title and frontmatter are included \u2014 not the note body.",
    });

    new Setting(contextPane)
      .setName("Template folder")
      .setDesc("Vault path to folder containing .md prompt templates")
      .addText((text) => {
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
