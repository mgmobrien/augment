import { App, Notice, PluginSettingTab, Setting, TFile, TFolder, setIcon } from "obsidian";
import AugmentTerminalPlugin from "./main";
import { AugmentSettings, TerminalOpenLocation } from "./vault-context";
import { calculateCost, modelDisplayName } from "./ai-client";
import { VIEW_TYPE_CONTEXT_INSPECTOR } from "./context-inspector-view";
import { detectDeps, invalidateDepsCache, CCDeps } from "./deps";
import { setupVaultForClaude } from "./vault-setup";
import { runGenerateTemplatesFlow, TemplateAssistantModal } from "./template-picker";





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
    if (m === "Mod")        parts.push(isMac ? "Cmd" : "Ctrl");
    else if (m === "Ctrl")  parts.push("Ctrl");
    else if (m === "Shift") parts.push("Shift");
    else if (m === "Alt")   parts.push(isMac ? "Opt" : "Alt");
  }
  parts.push(key === "Enter" ? "Enter" : key.toUpperCase());
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

function getSetupStep(deps: CCDeps, isWsl: boolean): WizardStep | null {
  if (!deps.node) {
    return {
      title: "Install AI tools",
      desc: isWsl
        ? "Node.js is needed to run Claude Code. Install it inside WSL using Linux commands — not the Windows installer."
        : "Node.js is needed to run Claude Code. Download and run the installer from nodejs.org.",
      action: "link",
      actionLabel: "Open nodejs.org \u2197",
      actionUrl: "https://nodejs.org",
    };
  }
  if (!deps.cc) {
    return {
      title: "Set up your AI assistant",
      desc: isWsl
        ? "A terminal will open and install Claude Code automatically. This runs inside WSL — use Linux commands."
        : "A terminal will open and install Claude Code automatically.",
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
    if (commandId.includes("template")) return isMac ? "Cmd+Shift+Enter" : "Ctrl+Shift+Enter";
    return isMac ? "Cmd+Enter" : "Ctrl+Enter";
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
      text: "In-editor AI generation and a terminal system for Claude Code.",
    });

    // ── Tab nav ──────────────────────────────────────────────
    const tabNav = containerEl.createEl("div", { cls: "augment-tab-nav" });
    const overviewTab = tabNav.createEl("button", { cls: "augment-tab is-active", text: "Overview" });

    // Continuation + Templates tabs appear after first generation (tier 1).
    const continuationTab = this.plugin.settings.hasGenerated
      ? tabNav.createEl("button", { cls: "augment-tab", text: "Generate" })
      : null;
    const templatesTab = this.plugin.settings.hasGenerated
      ? tabNav.createEl("button", { cls: "augment-tab", text: "Templates" })
      : null;

    const terminalTab = tabNav.createEl("button", { cls: "augment-tab", text: "Terminal" });

    // ── Panes ────────────────────────────────────────────────
    const overviewPane      = containerEl.createEl("div", { cls: "augment-tab-pane" });
    const continuationPane  = containerEl.createEl("div", { cls: "augment-tab-pane" });
    const templatesPane     = containerEl.createEl("div", { cls: "augment-tab-pane" });
    const terminalPane      = containerEl.createEl("div", { cls: "augment-tab-pane" });
    continuationPane.style.display  = "none";
    templatesPane.style.display = "none";
    terminalPane.style.display  = "none";

    const tabs: { btn: HTMLButtonElement; pane: HTMLElement }[] = [
      { btn: overviewTab,  pane: overviewPane },
      ...(continuationTab ? [{ btn: continuationTab, pane: continuationPane }] : []),
      ...(templatesTab    ? [{ btn: templatesTab,    pane: templatesPane    }] : []),
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


    // ── Tab header: welcome block + hotkeys ──────────────────
    const isMac = process.platform === "darwin";
    {
      const overviewHeader = overviewPane.createDiv({ cls: "augment-tab-header" });
      const overviewIntro  = overviewHeader.createDiv({ cls: "augment-tab-intro" });

      // Welcome block — orientation copy, no icon
      const welcomeEl = overviewIntro.createDiv({ cls: "augment-welcome" });
      const copyEl = welcomeEl.createDiv({ cls: "augment-welcome-copy" });
      copyEl.createDiv({
        cls: "augment-welcome-line1",
        text: "Augment — AI generation and Claude Code terminals for Obsidian.",
      });
      copyEl.createDiv({
        cls: "augment-welcome-line2",
        text: `Press ${isMac ? "Cmd" : "Ctrl"}+Enter to generate text, or Ctrl+T to open a terminal.`,
      });

      // Hotkey box — pinned right
      this.renderHotkeyBox(overviewHeader, [
        { label: "Generate",      commandId: "augment-terminal:augment-generate" },
        { label: "Open terminal", commandId: "augment-terminal:open-terminal" },
      ]);
    }

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


    // ── Keyboard shortcuts (Advanced) ─────────────────────────
    {
      const shortcutsDetails = overviewPane.createEl("details", { cls: "augment-advanced-details" });
      shortcutsDetails.createEl("summary", { cls: "augment-advanced-summary", text: "Keyboard shortcuts" });

      interface AugmentCmd { id: string; label: string; defaultKeys: { modifiers: string[]; key: string }[]; }
      const AUGMENT_CMDS: AugmentCmd[] = [
        { id: "augment-generate",               label: "Generate",                              defaultKeys: [{ modifiers: ["Mod"],           key: "Enter" }] },
        { id: "augment-generate-from-template", label: "Generate from template",                defaultKeys: [{ modifiers: ["Mod", "Shift"],  key: "Enter" }] },
        { id: "open-terminal",                  label: "Open terminal (default location)",      defaultKeys: [{ modifiers: ["Ctrl"], key: "t" }] },
        { id: "open-terminal-tab",              label: "Open terminal in new tab",              defaultKeys: [] },
        { id: "open-terminal-right",            label: "Open terminal to the right",            defaultKeys: [] },
        { id: "open-terminal-down",             label: "Open terminal below",                   defaultKeys: [] },
        { id: "open-terminal-sidebar-right-top",    label: "Open terminal in right sidebar (top)",    defaultKeys: [] },
        { id: "open-terminal-sidebar-right-bottom", label: "Open terminal in right sidebar (bottom)", defaultKeys: [] },
        { id: "open-terminal-sidebar-left-top",     label: "Open terminal in left sidebar (top)",     defaultKeys: [] },
        { id: "open-terminal-sidebar-left-bottom",  label: "Open terminal in left sidebar (bottom)",  defaultKeys: [] },
        { id: "open-terminal-manager",          label: "Show terminal manager",                 defaultKeys: [{ modifiers: ["Ctrl", "Shift"], key: "t" }] },
        { id: "switch-terminal",                label: "Switch terminal",                       defaultKeys: [] },
        { id: "rename-terminal",                label: "Rename terminal",                       defaultKeys: [] },
        { id: "augment-view-context",           label: "Open context inspector",                defaultKeys: [] },
        { id: "jump-to-next-waiting-session",   label: "Jump to next session needing attention", defaultKeys: [] },
        { id: "augment-open-settings",          label: "Open settings",                         defaultKeys: [] },
      ];

      const renderHotkeyStr = (hk: { modifiers: string[]; key: string }): string =>
        formatHotkeyStr(hk.modifiers, hk.key, isMac);

      const hm = (this.app as any).hotkeyManager;
      const customKeys: Record<string, { modifiers: string[]; key: string }[]> = hm?.customKeys ?? {};

      const kbTable = shortcutsDetails.createEl("table", { cls: "augment-var-table" });
      const kbTbody = kbTable.createEl("tbody");

      for (const cmd of AUGMENT_CMDS) {
        const fullId = "augment-terminal:" + cmd.id;
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

      const customizeEl = shortcutsDetails.createEl("div", { cls: "augment-shortcuts-customize" });
      const customizeLink = customizeEl.createEl("a", { text: "Customize in Settings \u2192 Keyboard shortcuts" });
      customizeLink.href = "#";
      customizeLink.addEventListener("click", (e) => {
        e.preventDefault();
        (this.app as any).setting.openTabById("hotkeys");
      });
    }

    // ── API usage (visible after first generation) ────────────
    if (this.plugin.settings.hasGenerated) {
      const spendSection = overviewPane.createDiv({ cls: "augment-spend-section" });

      const header = spendSection.createDiv({ cls: "augment-spend-header" });
      const titleWrap = header.createDiv({ cls: "augment-spend-title-wrap" });
      titleWrap.createSpan({ cls: "augment-spend-title", text: "Estimated API usage" });
      const spend = this.plugin.spendData;
      if (spend?.since) {
        const sinceDate = new Date(spend.since);
        const sinceStr = sinceDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        titleWrap.createSpan({ cls: "augment-spend-since", text: `since ${sinceStr}` });
      }
      const headerActions = header.createDiv({ cls: "augment-spend-header-actions" });
      const consoleLink = headerActions.createEl("a", { cls: "augment-spend-console-link", text: "Anthropic console \u2197" });
      consoleLink.href = "https://console.anthropic.com/usage";
      consoleLink.target = "_blank";
      consoleLink.rel = "noopener noreferrer";
      const resetLink = headerActions.createEl("a", { cls: "augment-spend-reset-link", text: "Reset" });
      resetLink.href = "#";
      resetLink.addEventListener("click", async (e) => {
        e.preventDefault();
        await this.plugin.resetSpendData();
        this.display();
      });

      const models = spend ? Object.keys(spend.byModel) : [];

      if (models.length === 0) {
        const emptyEl = spendSection.createDiv({ cls: "augment-spend-empty" });
        emptyEl.createEl("p", { text: "No generations tracked yet." });
        emptyEl.createEl("p", { cls: "augment-spend-cta", text: "Try Cmd+Enter in any note to generate text with AI." });
        emptyEl.createEl("p", { cls: "augment-spend-cta", text: "Or use Run template (Cmd+Shift+Enter) to apply a saved template." });
      } else {
        let totalCost = 0;
        let totalGens = 0;
        for (const [modelId, entry] of Object.entries(spend!.byModel)) {
          totalCost += calculateCost(modelId, entry.inputTokens, entry.outputTokens);
          totalGens += entry.generations;
        }

        const card = spendSection.createDiv({ cls: "augment-spend-card" });
        const totals = card.createDiv({ cls: "augment-spend-totals" });
        totals.createSpan({ cls: "augment-spend-total-amount", text: `$${totalCost.toFixed(4)} estimated` });
        totals.createSpan({ cls: "augment-spend-total-meta", text: `across ${totalGens} generation${totalGens === 1 ? "" : "s"}` });

        const table = card.createEl("table", { cls: "augment-var-table augment-spend-table" });
        const tbody = table.createEl("tbody");
        for (const [modelId, entry] of Object.entries(spend!.byModel)) {
          const cost = calculateCost(modelId, entry.inputTokens, entry.outputTokens);
          const tr = tbody.createEl("tr");
          tr.createEl("td", { text: modelDisplayName(modelId) });
          tr.createEl("td", { cls: "augment-spend-ms", text: `${entry.generations} gen${entry.generations === 1 ? "" : "s"}` });
          tr.createEl("td", { cls: "augment-spend-ms", text: `$${cost.toFixed(4)}` });
        }
      }

      const infobox = spendSection.createDiv({ cls: "augment-spend-infobox" });
      infobox.createSpan({ cls: "augment-spend-infobox-icon", text: "\u2139" });
      infobox.createSpan({ cls: "augment-spend-infobox-text", text: "Terminal (Claude Code) session costs aren\u2019t tracked here \u2014 they appear in your Anthropic console. Figures shown are estimates; actual charges may differ due to caching and rounding." });
    }

    // ── Continuation pane ────────────────────────────────────
    {
      const contHeader = continuationPane.createDiv({ cls: "augment-tab-header" });
      const contIntro  = contHeader.createDiv({ cls: "augment-tab-intro" });
      contIntro.createEl("p", {
        cls: "augment-context-intro",
        text: "Generate inserts AI-written text at your cursor in any open note. Press Cmd+Enter (Ctrl+Enter on Windows/Linux) to trigger it — the AI sees your note title, frontmatter, surrounding context, and linked notes.",
      });
      this.renderHotkeyBox(contHeader, [
        { label: "Generate",      commandId: "augment-terminal:augment-generate" },
        { label: "Run template",  commandId: "augment-terminal:augment-generate-from-template" },
      ]);
    }
    const RIBBON_ICONS: Record<string, string> = {
      "augment-pyramid": "Augment pyramid (default)",
      "radio-tower": "Sensor tower",
      "wand-2": "Wand",
      "sparkles": "Sparkles",
      "brain": "Brain",
      "zap": "Zap",
      "bot": "Bot",
      "pencil": "Pencil",
      "type": "Type",
      "message-square": "Message square",
      "cpu": "CPU",
      "code-2": "Code",
      "terminal": "Terminal",
    };

    const ribbonIconSetting = new Setting(continuationPane)
      .setName("Generate ribbon icon")
      .setDesc("Icon shown on the Generate ribbon button.")
      .addDropdown((dd) => {
        for (const [id, label] of Object.entries(RIBBON_ICONS)) {
          dd.addOption(id, label);
        }
        dd.setValue(this.plugin.settings.ribbonIcon || "augment-pyramid");
        dd.onChange(async (val) => {
          this.plugin.settings.ribbonIcon = val;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyRibbonIcon();
          if (ribbonPreviewEl) setIcon(ribbonPreviewEl, val);
        });
      });

    const ribbonPreviewEl = ribbonIconSetting.controlEl.createEl("span", { cls: "augment-ribbon-icon-preview" });
    ribbonPreviewEl.style.cssText = "display:inline-flex;align-items:center;margin-left:8px;opacity:0.7;";
    setIcon(ribbonPreviewEl, this.plugin.settings.ribbonIcon || "augment-pyramid");

    new Setting(continuationPane)
      .setName("Colored Generate icon")
      .setDesc("Show the Generate ribbon icon in color (red/green/blue). When off, the icon stays monochrome.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.coloredRibbonIcon).onChange(async (val) => {
          this.plugin.settings.coloredRibbonIcon = val;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyRibbonColoredClass();
        });
      });

    const calloutTypes = detectCalloutTypes();

    const formatSetting = new Setting(continuationPane)
      .setName("Output format")
      .setDesc("How generated text is wrapped when inserted.")
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

    addInfoTooltip(formatSetting.descEl, "Plain: text appears inline. Callout: wrapped in an Obsidian callout box (e.g. > [!ai]+). Blockquote: indented with >. Heading: text follows a new heading. Code block: text inside a fenced code block. The secondary dropdown sets the heading level or callout type.");

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

    const linkedNotesSetting = new Setting(continuationPane)
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
    addInfoTooltip(linkedNotesSetting.descEl, "Outgoing wikilinks only — notes the current note links to, not notes that link back to it. Frontmatter (tags, aliases, custom properties) is included; note body is not. Use {{linked_notes_full}} in a template if you need the full body content.");

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

    {
      const contextLimitSetting = new Setting(continuationPane)
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
      addInfoTooltip(contextLimitSetting.descEl, "Controls how many characters around your cursor are sent to Claude. Increase for long notes where you want Claude to see more surrounding content. Higher values use more tokens per request, which slightly increases cost and response time.");

      const systemPromptSetting = new Setting(continuationPane)
        .setName("System prompt")
        .setDesc("Sent to Claude before every generation. Supports LiquidJS variables — {{ now }} inserts the current date and time.")
        .addTextArea((text) => {
          text
            .setPlaceholder("The current date and time is {{ now }}.")
            .setValue(this.plugin.settings.systemPrompt)
            .onChange(async (value) => {
              this.plugin.settings.systemPrompt = value;
              await this.plugin.saveData(this.plugin.settings);
            });
          text.inputEl.rows = 5;
          text.inputEl.style.width = "100%";
          text.inputEl.style.fontFamily = "var(--font-monospace)";
        });
      addInfoTooltip(systemPromptSetting.descEl, "Sent to Claude before every generation. Supports LiquidJS: {{ now }} → current date and time. Use to set a persona, language, or domain focus for the entire vault. Individual templates can override this via system_prompt: in their frontmatter.");

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

      // ── Hotkey conflict ──
      {
        const generateHotkey = this.formatHotkey("augment-terminal:augment-generate");

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
    }

    // ── Templates pane ───────────────────────────────────────
    {
      const tplHeader = templatesPane.createDiv({ cls: "augment-tab-header" });
      const tplIntro  = tplHeader.createDiv({ cls: "augment-tab-intro" });
      tplIntro.createEl("p", {
        cls: "augment-context-intro",
        text: "Templates let you define reusable prompts for common generation tasks. Each template is a Markdown file in your templates folder. Use Cmd+Shift+Enter (or right-click \u2192 Run template) to pick and run a template on the current note.",
      });
      this.renderHotkeyBox(tplHeader, [
        { label: "Run template", commandId: "augment-terminal:augment-generate-from-template" },
      ]);
    }
    // ELI5 — collapsed by default, visible to all tiers.
    const eli5Details = templatesPane.createEl("details", { cls: "augment-hbs-details augment-eli5-details" });
    eli5Details.createEl("summary", { cls: "augment-hbs-summary", text: "What is a template?" });
    const eli5Body = eli5Details.createDiv({ cls: "augment-hbs-body augment-eli5-body" });
    eli5Body.createEl("p", {
      cls: "augment-hbs-intro",
      text: "A template is a Markdown file with instructions for Claude and variables that pull in content from your note.",
    });
    eli5Body.createEl("pre", {
      cls: "augment-format-example",
      text: "---\nname: Meeting summary\ndescription: Summarises a note into action items\n---\nExtract the key action items from this note:\n\n{{note_content}}",
    });
    const eli5Footer = eli5Body.createEl("p", { cls: "augment-eli5-footer" });
    eli5Footer.appendText("When you run a template, Augment fills in the variables and sends the instructions to Claude. Use ");
    eli5Footer.createEl("strong", { text: "Generate template" });
    eli5Footer.appendText(" below to create one with AI, or ");
    eli5Footer.createEl("strong", { text: "+ New template" });
    eli5Footer.appendText(" to start from scratch.");

    // Template folder setting.
    const templateFolderSetting = new Setting(templatesPane)
      .setName("Template folder")
      .setDesc("Vault path to the folder containing .md prompt templates.")
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
    addInfoTooltip(templateFolderSetting.descEl, "Path relative to your vault root (e.g. 'Augment/templates'). Each .md file in this folder appears as a template in the picker. Use the frontmatter fields name and description to control how templates are displayed.");

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

    // "Generate template" assistant button.
    new Setting(templatesPane)
      .setName("Generate template")
      .setDesc("Describe what you want in plain English and Augment will write a Liquid template for you.")
      .addButton((btn) => {
        btn.setButtonText("Generate template\u2026").setCta().onClick(() => {
          const targetFolder = this.plugin.settings.templateFolder || "Augment/templates";
          new TemplateAssistantModal(
            this.app,
            this.plugin.settings,
            this.plugin.resolveModel(),
            targetFolder,
            () => renderTemplateList()
          ).open();
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

    // Reference section and "Generate templates from folder" — unlocked after first template use (tier 2).
    if (this.plugin.settings.hasUsedTemplate) {
      // "Generate templates from folder" button.
      const genTplSetting = new Setting(templatesPane)
        .setName("Generate templates from folder")
        .setDesc("Scan a vault folder and generate LiquidJS templates based on the content patterns found there.")
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

      // Reference section — variables table + format guide.
      templatesPane.createDiv({ cls: "augment-pane-section", text: "Reference" });

    // Variables box.
    templatesPane.createDiv({ cls: "augment-section-label", text: "Variables" });
    const varRef = templatesPane.createDiv({ cls: "augment-ref-block augment-variable-ref" });
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

    // Template format box — frontmatter fields table + body example.
    templatesPane.createDiv({ cls: "augment-section-label", style: "margin-top: 16px;", text: "Template format" });
    const formatGuide = templatesPane.createDiv({ cls: "augment-ref-block augment-template-format" });
    formatGuide.createDiv({ cls: "augment-section-label", style: "margin-bottom: 6px;", text: "Frontmatter fields" });
    const fmTable = formatGuide.createEl("table", { cls: "augment-frontmatter-table" });
    const fmTbody = fmTable.createEl("tbody");
    const fmRows = [
      { key: "name",          desc: "Required. Shown in the template picker." },
      { key: "description",   desc: "Optional. Shown below the name in the picker." },
      { key: "system_prompt", desc: "Optional. Overrides Claude\u2019s default persona for this template only. Omit to use the vault-wide system prompt (Generate tab \u2192 System prompt)." },
    ];
    for (const r of fmRows) {
      const tr = fmTbody.createEl("tr");
      tr.createEl("td", { text: r.key });
      tr.createEl("td", { text: r.desc });
    }
    formatGuide.createDiv({ cls: "augment-section-label", style: "margin-top: 12px; margin-bottom: 6px;", text: "Template body" });
    formatGuide.createEl("pre", {
      cls: "augment-format-example",
      text: "Summarise the following note and its linked notes as bullet points.\n\n{{note_content}}\n\n{% if linked_notes %}Linked context:\n{{ linked_notes }}{% endif %}",
    });

    // LiquidJS syntax guide — collapsible for progressive disclosure.
    const hbsDetails = templatesPane.createEl("details", { cls: "augment-hbs-details" });
    hbsDetails.createEl("summary", { cls: "augment-hbs-summary", text: "Syntax reference (LiquidJS)" });

    const hbsBody = hbsDetails.createDiv({ cls: "augment-hbs-body" });
    hbsBody.createEl("p", {
      cls: "augment-hbs-intro",
      text: "Templates use LiquidJS. Use {{ }} for variables, {% %} for logic, and | filters to transform values.",
    });

    const syntaxRows: { syntax: string; desc: string }[] = [
      { syntax: "{{ variable }}",                                           desc: "Insert variable value" },
      { syntax: "{% if selection %}…{% endif %}",                           desc: "Include block only when non-empty" },
      { syntax: "{% if selection %}…{% else %}…{% endif %}",               desc: "Conditional with fallback" },
      { syntax: "{% unless selection %}…{% endunless %}",                   desc: "Include when empty / falsy" },
      { syntax: "{% for tag in tags %}{{ tag }}{% endfor %}",               desc: "Loop over an array" },
      { syntax: "{{ note_content | truncate: 500 }}",                       desc: "Trim to 500 characters" },
      { syntax: "{{ note_content | truncatewords: 100 }}",                  desc: "Trim to 100 words" },
      { syntax: "{{ tags | join: ', ' }}",                                  desc: "Join array with separator" },
      { syntax: "{{ variable | upcase }}",                                  desc: "Upper-case a string" },
      { syntax: "{{ variable | default: 'fallback' }}",                     desc: "Use fallback when empty" },
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
      text: "Summarise the following:\n\n{% if selection %}{{ selection }}{% else %}{{ note_content }}{% endif %}",
    });

    const hbsLink = hbsBody.createEl("a", {
      cls: "augment-hbs-docs-link",
      text: "See the full LiquidJS guide \u2192",
      href: "https://liquidjs.com/tags/overview.html",
    });
    hbsLink.target = "_blank";
    hbsLink.rel = "noopener";
    } // end hasUsedTemplate gate

    // ── Terminal pane ────────────────────────────────────────
    {
      const termHeader = terminalPane.createDiv({ cls: "augment-tab-header" });
      const termIntro  = termHeader.createDiv({ cls: "augment-tab-intro" });
      termIntro.createEl("p", {
        cls: "augment-context-intro",
        text: "The Terminals panel runs Claude Code sessions alongside your notes. Open a terminal with the + button in the Terminals panel, or via the command palette.",
      });
      this.renderHotkeyBox(termHeader, [
        { label: "Open terminal",    commandId: "augment-terminal:open-terminal" },
        { label: "Terminal manager", commandId: "augment-terminal:open-terminal-manager" },
        { label: "Next attention",   commandId: "augment-terminal:jump-to-next-waiting-session" },
      ]);
    }
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
      const activeStep = getSetupStep(deps, this.plugin.settings.shellPath === "wsl.exe");
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
        this.plugin.registerTieredCommands();
        this.plugin.addTerminalRibbonIfNeeded();
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

    // Location + other projects + advanced — visible only after terminal setup (tier 3).
    if (this.plugin.settings.terminalSetupDone) {
      // ── Default terminal location ────────────────────────────
      const terminalLocationSetting = new Setting(terminalPane)
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
      addInfoTooltip(terminalLocationSetting.descEl, "Applies to the + button in the Terminals panel and the 'Open terminal' command. Each position also has its own dedicated command (e.g. 'Open terminal in right sidebar (bottom)'). Bind those in Settings \u2192 Keyboard shortcuts to open a terminal in a specific spot without changing this default.");

      new Setting(terminalPane)
        .setName("Show other projects")
        .setDesc("Display Claude Code sessions from other projects in the Terminal Manager. Claude Code stores session data in ~/.claude/projects/ for every directory you've worked in — this reads that index. Your filesystem is not scanned directly.")
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.showOtherProjects)
            .onChange(async (value) => {
              this.plugin.settings.showOtherProjects = value;
              await this.plugin.saveData(this.plugin.settings);
              (this.plugin.app.workspace as any).trigger("augment-terminal:changed");
            });
        });

      // ── Workspace scope ──────────────────────────────────────
      new Setting(terminalPane)
        .setName("Workspace scope")
        .setDesc("Controls how the agent treats this workspace's paths relative to other workspaces.")
        .addDropdown((drop) => {
          drop
            .addOption("open", "No restrictions")
            .addOption("focused", "Focus on this workspace")
            .addOption("restricted", "Treat as private workspace")
            .setValue(this.plugin.settings.workspaceScope ?? "open")
            .onChange(async (value) => {
              this.plugin.settings.workspaceScope = value as "open" | "focused" | "restricted";
              await this.plugin.saveData(this.plugin.settings);
              renderScopeExtras();
            });
        });

      const scopeExtrasEl = terminalPane.createDiv({ cls: "augment-scope-extras" });
      const renderScopeExtras = () => {
        scopeExtrasEl.empty();
        const scope = this.plugin.settings.workspaceScope ?? "open";
        const path = (this.plugin.settings.defaultWorkingDirectory || "").trim();

        const descMap: Record<string, string> = {
          open: "The agent works across your full vault without scope guidance.",
          focused: "The agent is instructed to work within this workspace's paths and treat other workspaces as out of scope.",
          restricted: "The agent is instructed not to reference content from this workspace in outputs or summaries outside it.",
        };
        scopeExtrasEl.createDiv({ cls: "augment-scope-desc", text: descMap[scope] });

        if (path && scope !== "open") {
          const verb = scope === "focused" ? "focus on" : "treat as private";
          scopeExtrasEl.createDiv({ cls: "augment-scope-path", text: `The agent will ${verb}: ${path}` });
        }

        if (scope !== "open") {
          const box = scopeExtrasEl.createDiv({ cls: "augment-scope-infobox" });
          box.createSpan({ cls: "augment-scope-infobox-icon", text: "ℹ" });
          box.createSpan({ cls: "augment-scope-infobox-text", text: "Scope works through agent instructions — the agent is told to apply this, not technically prevented from other access." });
        }

        if (scope !== "open" && !path) {
          scopeExtrasEl.createDiv({
            cls: "augment-scope-validation",
            text: "Set a working directory (Terminal → Advanced → Working directory) to apply scope guidance.",
          });
        }
      };
      renderScopeExtras();

      // ── Advanced (collapsed by default) ─────────────────────
      const advancedDetails = terminalPane.createEl("details", { cls: "augment-advanced-details" });
      advancedDetails.createEl("summary", { cls: "augment-advanced-summary", text: "Advanced" });

      if (process.platform === "win32") {
        new Setting(advancedDetails)
          .setName("Shell")
          .setDesc("Shell to launch in new terminals.")
          .addDropdown((dropdown) => {
            const knownValues = ["", "wsl.exe", "cmd.exe"];
            const current = this.plugin.settings.shellPath;
            dropdown
              .addOption("", "PowerShell (default)")
              .addOption("wsl.exe", "WSL")
              .addOption("cmd.exe", "Command Prompt");
            // Preserve any custom shell path set before the dropdown existed.
            if (current && !knownValues.includes(current)) {
              dropdown.addOption(current, current);
            }
            dropdown
              .setValue(current)
              .onChange(async (value) => {
                this.plugin.settings.shellPath = value;
                await this.plugin.saveData(this.plugin.settings);
              });
          });
      } else {
        const defaultShell = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
        new Setting(advancedDetails)
          .setName("Shell")
          .setDesc("Custom shell path. Leave blank to use the system default.")
          .addText((text) => {
            text
              .setPlaceholder(defaultShell)
              .setValue(this.plugin.settings.shellPath)
              .onChange(async (value) => {
                this.plugin.settings.shellPath = value;
                await this.plugin.saveData(this.plugin.settings);
              });
          });
      }

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
    }

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
