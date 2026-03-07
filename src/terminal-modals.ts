import { Modal, Notice, Setting } from "obsidian";
import { TerminalView } from "./terminal-view";
import { scaffoldTeam, refreshTeamSkills, ScaffoldResult } from "./team-scaffold";

export type TeamCreateSpawnEvent = {
  sourceName?: string;
  team?: string;
  members?: string[];
};

export class RenameModal extends Modal {
  private view: TerminalView;
  private newName: string;

  constructor(app: any, view: TerminalView) {
    super(app);
    this.view = view;
    this.newName = view.getName();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Rename terminal" });

    new Setting(contentEl)
      .setName("Name")
      .addText((text) => {
        text.setValue(this.newName);
        text.onChange((value) => {
          this.newName = value;
        });
        text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            this.submit();
          }
        });
        // Focus and select all text
        setTimeout(() => {
          text.inputEl.focus();
          text.inputEl.select();
        }, 10);
      });

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText("Rename")
          .setCta()
          .onClick(() => this.submit());
      });
  }

  private submit(): void {
    const trimmed = this.newName.trim();
    if (trimmed) {
      this.view.setName(trimmed);
    }
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class InitTeamModal extends Modal {
  private projectPath = "";
  private refreshOnly: boolean;

  constructor(app: any, refreshOnly: boolean) {
    super(app);
    this.refreshOnly = refreshOnly;
  }

  onOpen(): void {
    const { contentEl } = this;
    const title = this.refreshOnly
      ? "Refresh team skills"
      : "Init team \u2014 scaffold .parts/";
    contentEl.createEl("h3", { text: title });

    const desc = this.refreshOnly
      ? "Overwrites SKILL.md files in .parts/skills/ with latest defaults. Config, state, and session files are never touched."
      : "Creates .parts/ with PARTS.md, per-role directories (config, state, sessions), and self-contained SKILL.md files.";
    contentEl.createEl("p", {
      text: desc,
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .setName("Project root")
      .setDesc("Absolute path to the project directory")
      .addText((text) => {
        text.setPlaceholder("/Users/you/Development/my-project");
        text.onChange((value) => {
          this.projectPath = value;
        });
        text.inputEl.style.width = "100%";
        text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") this.submit();
        });
        setTimeout(() => text.inputEl.focus(), 10);
      });

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText(this.refreshOnly ? "Refresh skills" : "Init team")
          .setCta()
          .onClick(() => this.submit());
      });
  }

  private submit(): void {
    const root = this.projectPath.trim();
    if (!root) {
      new Notice("Project path is required.");
      return;
    }

    try {
      const fs = require("fs") as typeof import("fs");
      if (!fs.existsSync(root)) {
        new Notice(`Directory not found: ${root}`);
        return;
      }

      let result: ScaffoldResult;
      if (this.refreshOnly) {
        const partsDir = require("path").join(root, ".parts");
        if (!fs.existsSync(partsDir)) {
          new Notice("No .parts/ directory found. Run Init team first.");
          return;
        }
        result = refreshTeamSkills(root);
        new Notice(`Refreshed ${result.created.length} skill files.`);
      } else {
        result = scaffoldTeam(root);
        const msg = result.created.length > 0
          ? `Created ${result.created.length} files. ${result.skipped.length} skipped (already exist).`
          : "Everything already exists \u2014 nothing to do.";
        new Notice(msg);
      }
    } catch (err: any) {
      new Notice(`Error: ${err.message}`);
      console.error("init-team error:", err);
    }

    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
