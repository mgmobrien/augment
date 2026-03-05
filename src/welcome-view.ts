import { ItemView, WorkspaceLeaf } from "obsidian";
import AugmentTerminalPlugin from "./main";

export const VIEW_TYPE_WELCOME = "augment-welcome";

export class WelcomeView extends ItemView {
  private plugin: AugmentTerminalPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: AugmentTerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_WELCOME; }
  getDisplayText(): string { return "Get started"; }
  getIcon(): string { return "zap"; }

  async onOpen(): Promise<void> {
    const el = this.containerEl.children[1] as HTMLElement;
    el.addClass("augment-welcome");
    this.render(el);
  }

  private openSettings(): void {
    (this.app as any).setting.open();
    (this.app as any).setting.openTabById("augment-terminal");
  }

  private render(el: HTMLElement): void {
    el.empty();
    const wrap = el.createEl("div", { cls: "augment-welcome-wrap" });

    wrap.createEl("h1", { cls: "augment-welcome-title", text: "Get started with Augment" });
    wrap.createEl("p", {
      cls: "augment-welcome-tagline",
      text: "Augment adds AI-powered writing continuation and Claude Code terminal sessions to Obsidian.",
    });

    // Step 1: API key
    const step1 = wrap.createEl("div", { cls: "augment-welcome-section" });
    step1.createEl("h2", { text: "Step 1 \u2014 Add your API key" });
    step1.createEl("p", {
      text: "You need a console API key from console.anthropic.com \u2014 not your Claude.ai login.",
    });

    const warn = step1.createEl("div", { cls: "augment-welcome-warning" });
    const warnStrong = warn.createEl("strong");
    warnStrong.setText("Claude Max/Pro subscriptions don\u2019t work here.");
    warn.appendText(
      " Anthropic prohibits OAuth tokens in third-party tools (Feb 2026). You need a pay-per-token console key starting with "
    );
    warn.createEl("code", { text: "sk-ant-api03-" });
    warn.appendText(". Billing is separate from any subscription.");

    const btn = step1.createEl("button", { cls: "augment-welcome-btn mod-cta", text: "Open settings \u2192" });
    btn.addEventListener("click", () => this.openSettings());

    // Step 2: Try it
    const step2 = wrap.createEl("div", { cls: "augment-welcome-section" });
    step2.createEl("h2", { text: "Step 2 \u2014 Try continuation" });
    step2.createEl("p", {
      text: "Open any note. Write something. Press Mod+Enter. Augment continues from where you are, using your note title, frontmatter, surrounding text, and linked notes as context.",
    });

    // What else is here
    const more = wrap.createEl("div", { cls: "augment-welcome-section" });
    more.createEl("h2", { text: "What else is here" });

    const list = more.createEl("ul", { cls: "augment-welcome-list" });

    const tmpl = list.createEl("li");
    tmpl.createEl("strong", { text: "Templates (Cmd+Shift+Enter)" });
    tmpl.appendText(" \u2014 reusable prompt files. Configure the folder in Settings \u2192 Templates.");

    const cc = list.createEl("li");
    cc.createEl("strong", { text: "Claude Code terminal sessions" });
    cc.appendText(" \u2014 run CC agents alongside your notes. Settings \u2192 Terminal has a guided setup wizard.");

    // Footer
    const footer = wrap.createEl("div", { cls: "augment-welcome-footer" });
    footer.appendText("Return here any time: command palette \u2192 ");
    footer.createEl("kbd", { text: "Augment: Open welcome" });
    footer.appendText(". Or go to Settings \u2192 Augment.");
  }

  async onClose(): Promise<void> {
    (this.containerEl.children[1] as HTMLElement).empty();
  }
}
