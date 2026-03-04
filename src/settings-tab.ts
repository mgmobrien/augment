import { App, PluginSettingTab, Setting } from "obsidian";
import AugmentTerminalPlugin from "./main";
import { AugmentSettings } from "./vault-context";

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

    new Setting(containerEl)
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

    new Setting(containerEl)
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

    let headingLevelSetting: Setting;
    let calloutTypeSetting: Setting;

    new Setting(containerEl)
      .setName("Output format")
      .setDesc("How generated text is inserted into the editor")
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
            headingLevelSetting.settingEl.style.display = value === "heading" ? "" : "none";
            calloutTypeSetting.settingEl.style.display = value === "callout" ? "" : "none";
          });
      });

    headingLevelSetting = new Setting(containerEl)
      .setName("Heading level")
      .setDesc("Number of # characters (1–4)")
      .addDropdown((drop) => {
        drop
          .addOption("1", "H1")
          .addOption("2", "H2")
          .addOption("3", "H3")
          .addOption("4", "H4")
          .setValue(String(this.plugin.settings.headingLevel))
          .onChange(async (value) => {
            this.plugin.settings.headingLevel = parseInt(value, 10);
            await this.plugin.saveData(this.plugin.settings);
          });
      });
    headingLevelSetting.settingEl.style.display =
      this.plugin.settings.outputFormat === "heading" ? "" : "none";

    calloutTypeSetting = new Setting(containerEl)
      .setName("Callout type")
      .setDesc("Obsidian callout type (e.g. ai, note, info)")
      .addText((text) => {
        text
          .setPlaceholder("ai")
          .setValue(this.plugin.settings.calloutType)
          .onChange(async (value) => {
            this.plugin.settings.calloutType = value.trim() || "ai";
            await this.plugin.saveData(this.plugin.settings);
          });
      });
    calloutTypeSetting.settingEl.style.display =
      this.plugin.settings.outputFormat === "callout" ? "" : "none";

    new Setting(containerEl)
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

    const contextSection = containerEl.createEl("div", { cls: "augment-settings-section" });
    contextSection.createEl("h3", { text: "Context", cls: "augment-settings-section-heading" });
    contextSection.createEl("p", {
      text: "Each generation sends the model: your note\u2019s title and frontmatter, the text around your cursor (or your selection if you have one selected), and a configurable number of linked notes. For linked notes, only the note title and frontmatter are included \u2014 not the note body.",
      cls: "augment-settings-section-desc",
    });

    new Setting(containerEl)
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

    new Setting(containerEl)
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

    new Setting(containerEl)
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
  }
}
