import { App, Notice, PluginSettingTab, Setting, TFile, TFolder, setIcon } from "obsidian";
import AugmentTerminalPlugin from "./main";
import { AugmentSettings, TerminalOpenLocation } from "./vault-context";
import { calculateCost, modelDisplayName } from "./ai-client";
import { VIEW_TYPE_CONTEXT_INSPECTOR } from "./context-inspector-view";
import { detectDeps, invalidateDepsCache, CCDeps } from "./deps";
import { setupVaultForClaude } from "./vault-setup";
import { runGenerateTemplatesFlow } from "./template-picker";





// Appends an ⓘ hover tooltip to a setting's descEl.
function addInfoTooltip(descEl: HTMLElement, tipText: string): void {
  descEl.appendChild(
    createFragment((frag) => {
      frag.appendText("\u00a0");
      const icon = frag.createEl("span", { cls: "augment-api-key-info", text: "\u24d8" });
      let tip: HTMLElement | null = null;
      icon.addEventListener("mouseenter", () => {
        tip = document.createElement("div");
        tip.className = "augment-api-key-tip";
        tip.textContent = tipText;
        document.body.appendChild(tip);
        const rect = icon.getBoundingClientRect();
        tip.style.top = `${rect.bottom + 6}px`;
        tip.style.left = `${rect.left}px`;
      });
      icon.addEventListener("mouseleave", () => { tip?.remove(); tip = null; });
    })
  );
}

// Shared hotkey formatting helper used by formatHotkey() and the shortcuts table.
function formatHotkeyStr(mods: string[], key: string, isMac: boolean): string {
  const parts: string[] = [];
  for (const m of mods) {
    if (m === "Mod")        parts.push(isMac ? "⌘" : "Ctrl");
    else if (m === "Ctrl")  parts.push("Ctrl");
    else if (m === "Shift") parts.push("Shift");
    else if (m === "Alt")   parts.push(isMac ? "⌥" : "Alt");
  }
  parts.push(key === "Enter" ? "↩" : key.toUpperCase());
  return parts.join("+");
}

interface WizardStep {
  title: string;
  desc: string;
  action: "link" | "terminal" | "copy" | "vault";
  actionLabel: string;
  actionUrl?: string;
  terminalCmd?: string;
  copyText?: string;
  secondaryLabel?: string;
  secondaryUrl?: string;
}

function getSetupStep(deps: CCDeps): WizardStep | null {
  if (!deps.node) {
    return {
      title: "Install AI tools",
      desc: "Node.js is needed to run Claude Code. Download and run the installer from nodejs.org.",
      action: "link",
      actionLabel: "Open nodejs.org \u2197",
      actionUrl: "https://nodejs.org",
    };
  }
  if (!deps.cc) {
    return {
      title: "Set up your AI assistant",
      desc: "A terminal will open and install Claude Code automatically.",
      action: "terminal",
      actionLabel: "Install",
      terminalCmd: "npm install -g @anthropic-ai/claude-code\n",
    };
  }
  if (!deps.authed) {
    return {
      title: "Connect your Claude account",
      desc: "A terminal will open and your browser will launch for sign-in. Use the same account as claude.ai.",
      action: "terminal",
      actionLabel: "Sign in",
      terminalCmd: "claude auth login\n",
    };
  }
  if (!deps.vaultConfigured) {
    return {
      title: "Prepare your notes for AI",
      desc: "Creates a CLAUDE.md file so Claude Code understands your vault, and an agents/skills/ folder for agent skills.",
      action: "vault",
      actionLabel: "Set up vault",
    };
  }
  return null;
}

function getStepIndex(deps: CCDeps): { current: number; total: number } {
  const total = 4;
  if (!deps.node) return { current: 1, total };
  if (!deps.cc) return { current: 2, total };
  if (!deps.authed) return { current: 3, total };
  if (!deps.vaultConfigured) return { current: 4, total };
  return { current: total, total };
}

interface DepRow {
  label: string;
  done: (deps: CCDeps) => boolean;
  readyText: string;
  pendingText: string;
}

const DEP_ROWS: DepRow[] = [
  { label: "Node.js",        done: d => d.node,            readyText: "ready",     pendingText: "\u2014" },
  { label: "Claude Code",    done: d => d.cc,              readyText: "ready",     pendingText: "\u2014" },
  { label: "Sign in",        done: d => d.authed,          readyText: "signed in", pendingText: "\u2014" },
  { label: "Vault",          done: d => d.vaultConfigured, readyText: "ready",     pendingText: "\u2014" },
];

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

  /** Render a compact hotkey cheat-sheet box in the top-right of a settings pane. */
  private renderHotkeyBox(
    pane: HTMLElement,
    items: { label: string; commandId: string }[]
  ): void {
    const wrapper = pane.createEl("div", { cls: "augment-hotkey-cheatsheet-wrapper" });
    const box = wrapper.createEl("div", { cls: "augment-hotkey-cheatsheet" });
    box.createEl("div", { cls: "augment-hotkey-cheatsheet-title", text: "Keyboard shortcuts" });
    for (const { label, commandId } of items) {
      const row = box.createEl("div", { cls: "augment-hotkey-cheatsheet-row" });
      row.createEl("span", { cls: "augment-hotkey-cheatsheet-label", text: label });
      row.createEl("kbd", { cls: "augment-hotkey-cheatsheet-pill", text: this.formatHotkey(commandId) });
    }
    const customize = box.createEl("a", { cls: "augment-hotkey-cheatsheet-customize", text: "customize ↗" });
    customize.href = "#";
    customize.addEventListener("click", (e) => {
      e.preventDefault();
      (this.app as any).setting.openTabById("hotkeys");
    });
  }

  /** Read the current hotkey binding for a command and format for display. */
  private formatHotkey(commandId: string): string {
    const hm = (this.app as any).hotkeyManager;
    const isMac = process.platform === "darwin";

    // Try custom hotkeys first, then defaults
    const custom = hm?.customKeys?.[commandId];
    if (Array.isArray(custom) && custom.length > 0) {
      const h = custom[0];
      return formatHotkeyStr(h.modifiers || [], h.key || "?", isMac);
    }
    const defaults = hm?.defaultKeys?.[commandId];
    if (Array.isArray(defaults) && defaults.length > 0) {
      const h = defaults[0];
      return formatHotkeyStr(h.modifiers || [], h.key || "?", isMac);
    }

    // Hardcoded fallback if hotkeyManager isn't available
    if (commandId.includes("template")) return isMac ? "⌘+Shift+↩" : "Ctrl+Shift+↩";
    return isMac ? "⌘+↩" : "Ctrl+↩";
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
    const overviewTab      = tabNav.createEl("button", { cls: "augment-tab is-active", text: "Overview" });
    const continuationTab  = tabNav.createEl("button", { cls: "augment-tab", text: "Continuation" });
    const templatesTab     = tabNav.createEl("button", { cls: "augment-tab", text: "Templates" });
    const terminalTab      = tabNav.createEl("button", { cls: "augment-tab", text: "Terminal" });

    // ── Panes ────────────────────────────────────────────────
    const overviewPane      = containerEl.createEl("div", { cls: "augment-tab-pane" });
    const continuationPane  = containerEl.createEl("div", { cls: "augment-tab-pane" });
    const templatesPane     = containerEl.createEl("div", { cls: "augment-tab-pane" });
    const terminalPane      = containerEl.createEl("div", { cls: "augment-tab-pane" });
    continuationPane.style.display  = "none";
    templatesPane.style.display = "none";
    terminalPane.style.display  = "none";

    const tabs = [
      { btn: overviewTab,      pane: overviewPane      },
      { btn: continuationTab,  pane: continuationPane  },
      { btn: templatesTab,     pane: templatesPane },
      { btn: terminalTab,      pane: terminalPane  },
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
            setTimeout(() => apiKeyInputEl?.focus(), 50);
          },
        },
        {
          label: "Generate text for the first time",
          done: this.plugin.settings.hasGenerated,
          hotkey: process.platform === "darwin" ? "\u2318\u21a9" : "Ctrl+\u21a9",
          onClick: () => {
            const msg = process.platform === "darwin" ? "Press \u2318\u21a9 to generate in any note" : "Press Ctrl+Enter to generate in any note";
            console.log("[Augment]", msg);
            new Notice(msg);
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
        {
          label: "Set up terminal",
          done: this.plugin.settings.terminalSetupDone,
          hotkey: null,
          onClick: () => {
            jumpToTab(terminalTab, terminalPane);
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

    overviewPane.createEl("p", {
      cls: "augment-overview-intro",
      text: `Augment is designed for high-speed, in-editor continuation while also providing a deep integrated terminal system for running agents like Claude Code. Generate inline with ${process.platform === "darwin" ? "Cmd" : "Ctrl"}+Enter \u2014 context comes from your note title, frontmatter, everything above your cursor, and linked notes.`,
    });

    // API key (on Overview pane)
    const apiKeySetting = new Setting(overviewPane)
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
          href: "https://console.anthropic.com/settings/api-keys",
        });
        a.target = "_blank";
        a.rel = "noopener";
        frag.appendText("\u00a0");

        const infoIcon = frag.createEl("span", {
          cls: "augment-api-key-info",
          text: "\u24d8",
        });

        let tip: HTMLElement | null = null;

        infoIcon.addEventListener("mouseenter", () => {
          tip = document.createElement("div");
          tip.className = "augment-api-key-tip";
          tip.textContent =
            "Claude Max/Pro subscriptions don\u2019t work here \u2014 Anthropic prohibits OAuth tokens in third-party tools (Feb 2026). You need a pay-per-token console key starting with sk-ant-api03-. Billing is separate from any subscription.";
          document.body.appendChild(tip);
          const rect = infoIcon.getBoundingClientRect();
          tip.style.top = `${rect.bottom + 6}px`;
          tip.style.left = `${rect.left}px`;
        });

        infoIcon.addEventListener("mouseleave", () => {
          tip?.remove();
          tip = null;
        });
      })
    );

    // Model selector (on Overview pane)
    const FALLBACK_MODELS = [
      { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
    ];
    const modelList = this.plugin.availableModels.length > 0
      ? this.plugin.availableModels
      : FALLBACK_MODELS;

    const modelSetting = new Setting(overviewPane)
      .setName("Model")
      .setDesc("Claude model to use for generation. Auto selects the best available model.")
      .addDropdown((drop) => {
        drop.addOption("auto", "Auto (best available)");
        drop.addOption("auto-opus", "Latest Opus");
        drop.addOption("auto-sonnet", "Latest Sonnet");
        drop.addOption("auto-haiku", "Latest Haiku");
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
    addInfoTooltip(modelSetting.descEl, "Auto: picks the best model your API key can access. Latest Opus/Sonnet/Haiku: always uses the newest model in that tier without pinning to a specific version. Named models: pins to that exact version.");

    const howEl = overviewPane.createEl("div", { cls: "augment-overview-how" });
    howEl.createEl("div", { cls: "augment-overview-how-title", text: "How it works" });
    const howSteps = [
      "Position your cursor where you want output to appear.",
      `Press ${process.platform === "darwin" ? "Cmd" : "Ctrl"}+Enter (or right-click → Augment: Generate).`,
      "A loading indicator appears while Claude generates.",
      "The result is inserted at your cursor in the chosen format.",
    ];
    const ol = howEl.createEl("ol", { cls: "augment-overview-steps" });
    for (const step of howSteps) {
      ol.createEl("li", { text: step });
    }

    const mockEl = overviewPane.createEl("div", { cls: "augment-overview-mock" });
    mockEl.createEl("div", { cls: "augment-overview-mock-label", text: "Example output (callout format)" });
    mockEl.createEl("pre", {
      cls: "augment-overview-mock-code",
      text: `> [!ai]+ Claude Haiku 4.5\n>\n> Your generated text appears here,\n> inline in the document.`,
    });

    const linksEl = overviewPane.createEl("div", { cls: "augment-overview-links" });
    linksEl.createEl("div", { cls: "augment-overview-links-title", text: "Quick start" });
    const linkList = linksEl.createEl("ul", { cls: "augment-overview-link-list" });
    const items = [
      { label: "Configure output format", tab: continuationTab, pane: continuationPane },
      { label: "Manage templates",        tab: templatesTab,    pane: templatesPane    },
    ];
    for (const { label, tab, pane } of items) {
      const li = linkList.createEl("li");
      const a = li.createEl("a", { cls: "augment-overview-link", text: label });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        jumpToTab(tab, pane);
      });
    }

    // ── Keyboard shortcuts (Overview pane) ───────────────────
    const isMac = process.platform === "darwin";

    interface AugmentCmd { id: string; label: string; defaultKeys: { modifiers: string[]; key: string }[]; }
    const AUGMENT_CMDS: AugmentCmd[] = [
      { id: "augment-generate",               label: "Generate",                     defaultKeys: [{ modifiers: ["Mod"],           key: "Enter" }] },
      { id: "augment-generate-from-template", label: "Generate from template",       defaultKeys: [{ modifiers: ["Mod", "Shift"],  key: "Enter" }] },
      { id: "open-terminal",                  label: "Open terminal (default location)",     defaultKeys: [{ modifiers: ["Ctrl"], key: "t" }] },
      { id: "open-terminal-tab",             label: "Open terminal in new tab",            defaultKeys: [] },
      { id: "open-terminal-right",           label: "Open terminal to the right",          defaultKeys: [] },
      { id: "open-terminal-down",            label: "Open terminal below",                 defaultKeys: [] },
      { id: "open-terminal-sidebar-right-top",    label: "Open terminal in right sidebar (top)",    defaultKeys: [] },
      { id: "open-terminal-sidebar-right-bottom", label: "Open terminal in right sidebar (bottom)", defaultKeys: [] },
      { id: "open-terminal-sidebar-left-top",     label: "Open terminal in left sidebar (top)",     defaultKeys: [] },
      { id: "open-terminal-sidebar-left-bottom",  label: "Open terminal in left sidebar (bottom)",  defaultKeys: [] },
      { id: "open-terminal-manager",         label: "Show terminal manager",               defaultKeys: [{ modifiers: ["Ctrl", "Shift"], key: "t" }] },
      { id: "switch-terminal",               label: "Switch terminal",                     defaultKeys: [] },
      { id: "rename-terminal",               label: "Rename terminal",                     defaultKeys: [] },
      { id: "augment-view-context",           label: "Open context inspector",       defaultKeys: [] },
      { id: "jump-to-next-waiting-session",   label: "Jump to next waiting session", defaultKeys: [] },
      { id: "augment-open-settings",          label: "Open settings",                defaultKeys: [] },
    ];

    const renderHotkeyStr = (hk: { modifiers: string[]; key: string }): string =>
      formatHotkeyStr(hk.modifiers, hk.key, isMac);

    const hm = (this.app as any).hotkeyManager;
    const customKeys: Record<string, { modifiers: string[]; key: string }[]> = hm?.customKeys ?? {};

    const shortcutsEl = overviewPane.createEl("div", { cls: "augment-overview-shortcuts" });
    shortcutsEl.createEl("div", { cls: "augment-overview-how-title", text: "Keyboard shortcuts" });

    const kbTable = shortcutsEl.createEl("table", { cls: "augment-var-table" });
    const kbTbody = kbTable.createEl("tbody");

    for (const cmd of AUGMENT_CMDS) {
      const fullId = "augment-terminal:" + cmd.id;
      // User customizations (including cleared bindings) override plugin defaults.
      const effectiveKeys = fullId in customKeys ? customKeys[fullId] : cmd.defaultKeys;

      const tr = kbTbody.createEl("tr");
      tr.createEl("td", { cls: "augment-shortcuts-label", text: cmd.label });
      const keyTd = tr.createEl("td", { cls: "augment-shortcuts-keys" });
      if (effectiveKeys.length > 0) {
        for (const hk of effectiveKeys) {
          keyTd.createEl("kbd", { cls: "augment-onboarding-hotkey", text: renderHotkeyStr(hk) });
        }
      } else {
        keyTd.createEl("span", { cls: "augment-shortcuts-unset", text: "\u2014" });
      }
    }

    const customizeEl = shortcutsEl.createEl("div", { cls: "augment-shortcuts-customize" });
    const customizeLink = customizeEl.createEl("a", { text: "Customize in Settings \u2192 Keyboard shortcuts" });
    customizeLink.href = "#";
    customizeLink.addEventListener("click", (e) => {
      e.preventDefault();
      (this.app as any).setting.openTabById("hotkeys");
    });

    // ── Colored ribbon icon ────────────────────────────────────
    new Setting(overviewPane)
      .setName("Colored pyramid icon")
      .setDesc("Show the ribbon pyramid in S3 colors (red/green/blue). When off, the icon stays monochrome.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.coloredRibbonIcon).onChange(async (val) => {
          this.plugin.settings.coloredRibbonIcon = val;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyRibbonColoredClass();
        });
      });

    // ── Startup profiler ─────────────────────────────────────
    {
      const timings = this.plugin.startupTimings;
      const profilerSection = overviewPane.createDiv({ cls: "augment-profiler-section" });

      new Setting(profilerSection)
        .setName("Startup profiler")
        .setDesc("Measure how long each plugin takes to load. Takes effect on next Obsidian restart.")
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.enableProfiler).onChange(async (val) => {
            this.plugin.settings.enableProfiler = val;
            await this.plugin.saveData(this.plugin.settings);
            this.display();
          });
        });

      if (this.plugin.settings.enableProfiler) {
        if (!timings) {
          profilerSection.createEl("p", {
            cls: "augment-profiler-hint",
            text: "Restart Obsidian to capture startup timing.",
          });
        } else {
          const summaryEl = profilerSection.createDiv({ cls: "augment-profiler-summary" });
          summaryEl.createEl("div", { cls: "augment-profiler-row augment-profiler-own",
            text: `Augment (this plugin): ${timings.ownMs}ms` });
          summaryEl.createEl("div", { cls: "augment-profiler-row",
            text: `Total window (load \u2192 layout ready): ${timings.layoutReadyMs}ms` });

          if (timings.plugins.length > 0) {
            profilerSection.createDiv({ cls: "augment-pane-section augment-profiler-plugins-label", text: "Other plugins" });
            const table = profilerSection.createEl("table", { cls: "augment-var-table augment-profiler-table" });
            const tbody = table.createEl("tbody");
            for (const p of timings.plugins) {
              const tr = tbody.createEl("tr");
              tr.createEl("td", { text: p.name });
              const msEl = tr.createEl("td", { cls: "augment-profiler-ms", text: `${p.ms}ms` });
              if (p.ms > 500) msEl.addClass("augment-profiler-slow");
              else if (p.ms > 200) msEl.addClass("augment-profiler-med");
            }
          } else {
            profilerSection.createEl("p", {
              cls: "augment-profiler-hint",
              text: "No other plugin timings captured. Augment may not have loaded first — restart Obsidian to retry.",
            });
          }
        }
      }
    }

    // ── API usage ────────────────────────────────────────────
    {
      const spendSection = overviewPane.createDiv({ cls: "augment-spend-section" });
      spendSection.createDiv({ cls: "augment-overview-how-title", text: "API usage" });

      const spend = this.plugin.spendData;
      const models = spend ? Object.keys(spend.byModel) : [];

      if (models.length === 0) {
        spendSection.createEl("p", {
          cls: "augment-profiler-hint",
          text: "No generations tracked yet. Usage is recorded after each Generate call.",
        });
      } else {
        let totalCost = 0;
        let totalGens = 0;
        for (const [modelId, entry] of Object.entries(spend!.byModel)) {
          totalCost += calculateCost(modelId, entry.inputTokens, entry.outputTokens);
          totalGens += entry.generations;
        }

        const summaryEl = spendSection.createDiv({ cls: "augment-profiler-summary" });
        summaryEl.createEl("div", {
          cls: "augment-profiler-row augment-profiler-own",
          text: `Total cost: $${totalCost.toFixed(4)} across ${totalGens} generation${totalGens === 1 ? "" : "s"}`,
        });

        const table = spendSection.createEl("table", { cls: "augment-var-table augment-spend-table" });
        const tbody = table.createEl("tbody");
        for (const [modelId, entry] of Object.entries(spend!.byModel)) {
          const cost = calculateCost(modelId, entry.inputTokens, entry.outputTokens);
          const tr = tbody.createEl("tr");
          tr.createEl("td", { text: modelDisplayName(modelId) });
          tr.createEl("td", { cls: "augment-profiler-ms", text: `${entry.generations} gen${entry.generations === 1 ? "" : "s"}` });
          tr.createEl("td", { cls: "augment-profiler-ms", text: `$${cost.toFixed(4)}` });
        }
      }

      spendSection.createEl("p", {
        cls: "augment-spend-note",
        text: "Tracks Generate and Run template calls only. Terminal (Claude Code) sessions are not tracked — those costs appear in your Anthropic console.",
      });
    }

    // ── Continuation pane ────────────────────────────────────
    this.renderHotkeyBox(continuationPane, [
      { label: "Generate",          commandId: "augment-terminal:augment-generate" },
      { label: "Run template",      commandId: "augment-terminal:augment-generate-from-template" },
    ]);

    continuationPane.createEl("p", {
      cls: "augment-context-intro",
      text: "Generate inserts AI-written text at your cursor in any open note. Press Cmd+Enter (Ctrl+Enter on Windows/Linux) to trigger it — the AI sees your note title, frontmatter, surrounding context, and linked notes.",
    });

    const calloutTypes = detectCalloutTypes();

    const formatSetting = new Setting(continuationPane)
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

    continuationPane.createDiv({ cls: "augment-pane-section", text: "Context" });

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

    new Setting(continuationPane)
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

    new Setting(continuationPane)
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

    new Setting(continuationPane)
      .setName("Show generation notice")
      .setDesc("Show a brief notice when generation starts. Helps confirm the keyboard shortcut fired.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showGenerationToast)
          .onChange(async (value) => {
            this.plugin.settings.showGenerationToast = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    const systemPromptSetting = new Setting(continuationPane)
      .setName("System prompt")
      .setDesc("Override the default system prompt. Leave blank to use Augment's default.")
      .addTextArea((text) => {
        text
          .setPlaceholder("You are assisting with writing in an Obsidian vault.")
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveData(this.plugin.settings);
          });
        text.inputEl.rows = 5;
        text.inputEl.style.width = "100%";
        text.inputEl.style.fontFamily = "var(--font-monospace)";
      });
    addInfoTooltip(systemPromptSetting.descEl, "Augment's default prompt tells Claude your note title, frontmatter, and writing context. Override here to change how Claude approaches generation across this entire vault — useful for setting a persona, language, or domain focus.");

    const inspectorBtn = continuationPane.createEl("button", {
      cls: "augment-ctx-preview-btn",
      text: "Open context inspector",
    });
    inspectorBtn.addEventListener("click", () => {
      const leaf = this.plugin.app.workspace.getRightLeaf(false);
      if (leaf) {
        leaf.setViewState({ type: VIEW_TYPE_CONTEXT_INSPECTOR, active: true });
        this.plugin.app.workspace.revealLeaf(leaf);
      }
    });

    // ── Keyboard shortcuts ──
    {
      continuationPane.createDiv({ cls: "augment-pane-section", text: "Keyboard shortcuts" });

      const generateHotkey = this.formatHotkey("augment-terminal:augment-generate");
      const templateHotkey = this.formatHotkey("augment-terminal:augment-generate-from-template");

      new Setting(continuationPane)
        .setName(`Generate: ${generateHotkey}`)
        .setDesc("Run continuation on the current note.");

      new Setting(continuationPane)
        .setName(`Template: ${templateHotkey}`)
        .setDesc("Pick and run a template on the current note.");

      const openHotkeysPage = () => {
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById("hotkeys");
      };

      if (this.plugin.settings.clearedLinkHotkey) {
        const desc = document.createDocumentFragment();
        desc.appendText("Displaced: Open link in new tab.  ");
        const link = desc.createEl("a", { text: "Open keyboard shortcuts \u2197" });
        link.style.cursor = "pointer";
        link.addEventListener("click", () => openHotkeysPage());

        new Setting(continuationPane)
          .setName(`Generate: ${generateHotkey}`)
          .setDesc(desc)
          .addButton((btn) => {
            btn.setButtonText("Restore original")
              .onClick(async () => {
                await this.plugin.restoreObsidianLinkHotkey();
                this.display();
              });
          });
      } else {
        const desc2 = document.createDocumentFragment();
        desc2.appendText(`Obsidian\u2019s \u201cOpen link in new tab\u201d uses ${generateHotkey} by default, which blocks Augment\u2019s generate command.  `);
        const link2 = desc2.createEl("a", { text: "Open keyboard shortcuts \u2197" });
        link2.style.cursor = "pointer";
        link2.addEventListener("click", () => openHotkeysPage());

        new Setting(continuationPane)
          .setName(`${generateHotkey} conflict`)
          .setDesc(desc2)
          .addButton((btn) => {
            btn.setButtonText(`Claim ${generateHotkey}`)
              .setCta()
              .onClick(async () => {
                await this.plugin.clearObsidianLinkHotkey();
                this.display();
              });
          });
      }
    }

    // ── Templates pane ───────────────────────────────────────
    this.renderHotkeyBox(templatesPane, [
      { label: "Run template",      commandId: "augment-terminal:augment-generate-from-template" },
    ]);

    templatesPane.createEl("p", {
      cls: "augment-context-intro",
      text: "Templates let you define reusable prompts for common generation tasks. Each template is a Markdown file in your templates folder. Use Cmd+Shift+Enter (or right-click \u2192 Run template) to pick and run a template on the current note.",
    });

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
        console.log(`[Augment] folder not found: "${folderPath}"`);
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
    templatesPane.createDiv({ cls: "augment-pane-section", text: "Your templates" });
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

    // "Generate templates from folder" button.
    const genTplSetting = new Setting(templatesPane)
      .setName("Generate templates from folder")
      .setDesc("Scan a vault folder and generate Handlebars templates based on the content patterns found there.")
      .addButton((btn) => {
        btn.setButtonText("Choose folder\u2026").onClick(async () => {
          if (!this.plugin.settings.apiKey) {
            new Notice("Add an API key in the Overview tab first");
            return;
          }
          runGenerateTemplatesFlow(this.app, this.plugin.settings, this.plugin.resolveModel(), () => renderTemplateList());
        });
      });

    // Info icon — warns that this feature calls the API and incurs charges.
    genTplSetting.descEl.appendChild(
      createFragment((frag) => {
        frag.appendText("\u00a0");
        const infoIcon = frag.createEl("span", {
          cls: "augment-api-key-info",
          text: "\u24d8",
        });
        let tip: HTMLElement | null = null;
        infoIcon.addEventListener("mouseenter", () => {
          tip = document.createElement("div");
          tip.className = "augment-api-key-tip";
          tip.textContent = "This feature calls Claude to analyse your notes and write templates. It uses your API key and will incur charges. Larger folders or complex notes cost more.";
          document.body.appendChild(tip);
          const rect = infoIcon.getBoundingClientRect();
          tip.style.top = `${rect.bottom + 6}px`;
          tip.style.left = `${rect.left}px`;
        });
        infoIcon.addEventListener("mouseleave", () => {
          tip?.remove();
          tip = null;
        });
      })
    );

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
          console.log("[Augment] could not create template");
          new Notice("Could not create template");
        }
      }
    });

    // Reference section — variables table + format guide.
    templatesPane.createDiv({ cls: "augment-pane-section", text: "Reference" });

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

    const formatGuide = templatesPane.createDiv({ cls: "augment-template-format" });
    formatGuide.createDiv({ cls: "augment-section-label", text: "Template format" });
    formatGuide.createEl("pre", {
      cls: "augment-format-example",
      text: "---\nname: Template name\ndescription: Shown in picker\nsystem_prompt: |\n  You are Gus, a thinking partner embedded in this vault.\n  [optional \u2014 omit to use the default system prompt]\n---\nYour task instruction here.\n\n{{note_content}}",
    });

    // Handlebars syntax guide — collapsible for progressive disclosure.
    const hbsDetails = templatesPane.createEl("details", { cls: "augment-hbs-details" });
    hbsDetails.createEl("summary", { cls: "augment-hbs-summary", text: "Handlebars syntax" });

    const hbsBody = hbsDetails.createDiv({ cls: "augment-hbs-body" });
    hbsBody.createEl("p", {
      cls: "augment-hbs-intro",
      text: "Templates use Handlebars. Beyond variable insertion you can use conditionals and helpers.",
    });

    const syntaxRows: { syntax: string; desc: string }[] = [
      { syntax: "{{variable}}",                                  desc: "Insert variable value" },
      { syntax: "{{#if selection}}\u2026{{/if}}",                desc: "Include block only when non-empty" },
      { syntax: "{{#if selection}}\u2026{{else}}\u2026{{/if}}", desc: "Conditional with fallback" },
      { syntax: "{{#unless selection}}\u2026{{/unless}}",        desc: "Include when empty / falsy" },
      { syntax: "{{{variable}}}",                                desc: "Skip HTML escaping (safe for note content)" },
    ];
    const hbsTable = hbsBody.createEl("table", { cls: "augment-var-table" });
    const hbsTbody = hbsTable.createEl("tbody");
    for (const row of syntaxRows) {
      const tr = hbsTbody.createEl("tr");
      tr.createEl("td").createEl("code", { text: row.syntax });
      tr.createEl("td", { text: row.desc });
    }

    hbsBody.createDiv({ cls: "augment-section-label augment-hbs-example-label", text: "Example \u2014 use selection when present, fall back to full note" });
    hbsBody.createEl("pre", {
      cls: "augment-format-example",
      text: "Summarise the following:\n\n{{#if selection}}{{{selection}}}{{else}}{{{note_content}}}{{/if}}",
    });

    const hbsLink = hbsBody.createEl("a", {
      cls: "augment-hbs-docs-link",
      text: "See the full Handlebars guide \u2192",
      href: "https://handlebarsjs.com/guide/",
    });
    hbsLink.target = "_blank";
    hbsLink.rel = "noopener";

    // ── Terminal pane ────────────────────────────────────────
    this.renderHotkeyBox(terminalPane, [
      { label: "Open terminal",         commandId: "augment-terminal:open-terminal" },
      { label: "Terminal manager",      commandId: "augment-terminal:open-terminal-manager" },
      { label: "Next waiting session",  commandId: "augment-terminal:jump-to-next-waiting-session" },
    ]);

    terminalPane.createEl("p", {
      cls: "augment-context-intro",
      text: "The Terminals panel runs Claude Code sessions alongside your notes. Open a terminal with the + button in the Terminals panel, or via the command palette.",
    });

    // Setup wizard section
    const wizardSection = terminalPane.createDiv({ cls: "augment-setup-card" });
    const wizardBody = wizardSection.createDiv();

    const setupVault = async () => {
      const templateFolder = this.plugin.settings.templateFolder || "Augment/templates";
      await setupVaultForClaude(this.app, templateFolder);
    };

    const renderStatusCard = async () => {
      wizardBody.empty();
      wizardBody.createDiv({ cls: "augment-cc-detecting", text: "Checking your setup\u2026" });

      const deps = await detectDeps(this.app, { forceFresh: true });
      wizardBody.empty();

      const depRows = DEP_ROWS;
      const activeStep = getSetupStep(deps);
      const allReady = activeStep === null;

      // Header
      wizardBody.createEl("div", { cls: "augment-cc-status-title", text: "Set up Claude Code" });

      // Step progress (shown only while setup is incomplete)
      if (!allReady && activeStep) {
        const stepIdx = getStepIndex(deps);
        wizardBody.createEl("div", {
          cls: "augment-cc-step-progress",
          text: `Step ${stepIdx.current} of ${stepIdx.total}: ${activeStep.title}`,
        });
      }

      // Dep rows
      const list = wizardBody.createEl("div", { cls: "augment-cc-dep-list" });
      let activeFound = false;

      for (const row of depRows) {
        const isDone = row.done(deps);
        const isActive = !isDone && !activeFound;
        if (isActive) activeFound = true;
        const isPending = !isDone && !isActive;

        const rowEl = list.createEl("div", {
          cls: "augment-cc-dep-row" + (isDone ? " is-done" : isActive ? " is-active" : " is-pending"),
        });

        rowEl.createEl("span", {
          cls: "augment-cc-dep-icon",
          text: isDone ? "\u2713" : isActive ? "\u203a" : "\u25cb",
        });
        rowEl.createEl("span", { cls: "augment-cc-dep-label", text: row.label });

        if (isDone) {
          rowEl.createEl("span", { cls: "augment-cc-dep-status", text: row.readyText });
        } else if (isActive && activeStep) {
          const actionEl = rowEl.createEl("span", { cls: "augment-cc-dep-action" });

          if (activeStep.action === "link") {
            const btn = actionEl.createEl("button", { cls: "mod-cta augment-cc-dep-btn", text: activeStep.actionLabel });
            btn.addEventListener("click", () => window.open(activeStep.actionUrl!, "_blank"));
            if (activeStep.secondaryLabel && activeStep.secondaryUrl) {
              const sec = actionEl.createEl("a", { cls: "augment-cc-dep-secondary", text: activeStep.secondaryLabel });
              sec.href = activeStep.secondaryUrl;
              sec.target = "_blank";
              sec.rel = "noopener";
            }
          } else if (activeStep.action === "terminal") {
            const btn = actionEl.createEl("button", { cls: "mod-cta augment-cc-dep-btn", text: activeStep.actionLabel });
            btn.addEventListener("click", async () => {
              invalidateDepsCache();
              const view = await this.plugin.openFocusedTerminal();
              setTimeout(() => view.write(activeStep.terminalCmd!), 800);
            });
          } else if (activeStep.action === "copy") {
            actionEl.createEl("code", { cls: "augment-cc-dep-copy-text", text: activeStep.copyText! });
            const btn = actionEl.createEl("button", { cls: "mod-cta augment-cc-dep-btn", text: activeStep.actionLabel });
            btn.addEventListener("click", () => {
              navigator.clipboard.writeText(activeStep.copyText!);
              btn.textContent = "Copied!";
              setTimeout(() => { btn.textContent = activeStep.actionLabel; }, 1500);
            });
          } else if (activeStep.action === "vault") {
            const btn = actionEl.createEl("button", { cls: "mod-cta augment-cc-dep-btn", text: activeStep.actionLabel });
            btn.addEventListener("click", async () => {
              btn.textContent = "Setting up\u2026";
              btn.disabled = true;
              await setupVault();
              void renderStatusCard();
            });
          }

          // Show the step description under the action controls.
          if (activeStep.desc) {
            rowEl.createEl("div", { cls: "augment-cc-step-desc", text: activeStep.desc });
          }
        } else if (isPending) {
          rowEl.createEl("span", { cls: "augment-cc-dep-status is-pending", text: row.pendingText });
        }
      }

      // Mark terminal setup done when all deps pass.
      if (allReady && !this.plugin.settings.terminalSetupDone) {
        this.plugin.settings.terminalSetupDone = true;
        void this.plugin.saveData(this.plugin.settings);
        renderSetupCard();
      }

      // Footer
      const footer = wizardBody.createEl("div", { cls: "augment-cc-status-footer" });
      if (allReady) {
        footer.createEl("span", { cls: "augment-cc-all-ready", text: "Claude Code sessions are ready." });
      } else if (activeStep && activeStep.action !== "vault") {
        const doneLink = footer.createEl("a", { cls: "augment-cc-recheck", text: "Done \u2014 verify \u21ba" });
        doneLink.href = "#";
        doneLink.addEventListener("click", (e) => {
          e.preventDefault();
          doneLink.textContent = "Checking\u2026";
          doneLink.style.pointerEvents = "none";
          setTimeout(() => void renderStatusCard(), 300);
        });
      }
      const recheck = footer.createEl("a", { cls: "augment-cc-recheck-always", text: "Re-check \u21ba" });
      recheck.href = "#";
      recheck.addEventListener("click", (e) => { e.preventDefault(); void renderStatusCard(); });
    };

    void renderStatusCard();

    // ── Default terminal location ────────────────────────────
    new Setting(terminalPane)
      .setName("Default terminal location")
      .setDesc("Where new terminals open when using the default command or ribbon button. Use explicit location commands to bind keyboard shortcuts to specific positions.")
      .addDropdown((drop) => {
        drop
          .addOption("tab", "New tab")
          .addOption("split-right", "Split right")
          .addOption("split-down", "Split below")
          .addOption("sidebar-right-top", "Right sidebar (top)")
          .addOption("sidebar-right-bottom", "Right sidebar (bottom)")
          .addOption("sidebar-left-top", "Left sidebar (top)")
          .addOption("sidebar-left-bottom", "Left sidebar (bottom)")
          .setValue(this.plugin.settings.defaultTerminalLocation ?? "tab")
          .onChange(async (value) => {
            this.plugin.settings.defaultTerminalLocation = value as TerminalOpenLocation;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(terminalPane)
      .setName("Show other projects")
      .setDesc("Display Claude Code sessions from other directories on this machine in the Terminal Manager. Reads ~/.claude/projects/ — only Claude Code data, nothing else.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showOtherProjects)
          .onChange(async (value) => {
            this.plugin.settings.showOtherProjects = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    // ── Advanced (collapsed by default) ─────────────────────
    const advancedDetails = terminalPane.createEl("details", { cls: "augment-advanced-details" });
    advancedDetails.createEl("summary", { cls: "augment-advanced-summary", text: "Advanced" });

    new Setting(advancedDetails)
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

    new Setting(advancedDetails)
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

    // Filesystem rename notice
    terminalPane.createEl("p", {
      cls: "augment-terminal-notice",
      text: "Claude Code reads and writes vault files directly via the filesystem. Do not use CC to rename or move files \u2014 use Obsidian\u2019s built-in rename to preserve wikilinks.",
    });

    // <!-- Advanced: Obsidian MCP server setup (v2) -->

    // ── Version footer (all tabs) ──────────────────────────
    containerEl.createEl("div", {
      cls: "augment-settings-version",
      text: `v${this.plugin.manifest.version} · build ${this.plugin.getBuildFingerprint()}`,
    });
  }
}
