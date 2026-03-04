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

    new Setting(containerEl)
      .setName("Linked notes in context")
      .setDesc("Number of linked notes to include per generation (0–10)")
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
      .setName("Max context tokens")
      .setDesc("Soft cap on assembled context sent to the model")
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
