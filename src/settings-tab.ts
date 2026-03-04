import { App, PluginSettingTab, Setting } from "obsidian";
import AugmentTerminalPlugin from "./main";

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
