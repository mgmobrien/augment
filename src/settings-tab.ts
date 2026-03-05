import { App, Notice, PluginSettingTab, Setting, TFile, TFolder, setIcon } from "obsidian";
import { exec } from "child_process";
import AugmentTerminalPlugin from "./main";
import { AugmentSettings } from "./vault-context";
import { modelDisplayName } from "./ai-client";
import { VIEW_TYPE_CONTEXT_INSPECTOR } from "./context-inspector-view";

interface CCDeps {
  python: boolean;
  node: boolean;
  cc: boolean;
  authed: boolean;
  vaultConfigured: boolean;
  // Windows-only
  wsl?: boolean;
  pythonInWsl?: boolean;
  nodeInWsl?: boolean;
  ccInWsl?: boolean;
  authedInWsl?: boolean;
}

function execAsync(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

async function checkBool(cmd: string): Promise<boolean> {
  try {
    const r = await execAsync(cmd);
    return r.stdout.trim().length > 0;
  } catch { return false; }
}

async function checkAuth(prefix: string): Promise<boolean> {
  try {
    const r = await execAsync(`${prefix}claude auth status`);
    // Parse JSON output — look for loggedIn field.
    try {
      const parsed = JSON.parse(r.stdout.trim());
      if (typeof parsed.loggedIn === "boolean") return parsed.loggedIn;
    } catch { /* not JSON — fall through */ }
    // Heuristic: if command succeeded and doesn't say "not", assume authed.
    const lower = r.stdout.toLowerCase();
    return !lower.includes("not logged in") && !lower.includes("not authenticated");
  } catch { return false; }
}

async function detectDeps(app: App): Promise<CCDeps> {
  const platform = process.platform;
  const vaultConfigured = !!app.vault.getAbstractFileByPath("CLAUDE.md");

  if (platform === "win32") {
    const wsl = await checkBool("wsl --list");
    if (!wsl) return { python: false, node: false, cc: false, authed: false, vaultConfigured, wsl: false };

    const pythonInWsl = await checkBool("wsl -e python3 --version");
    const nodeInWsl = await checkBool("wsl -e node --version");
    const ccInWsl = nodeInWsl ? await checkBool("wsl -e which claude") : false;
    const authedInWsl = ccInWsl ? await checkAuth("wsl -e ") : false;

    return {
      python: pythonInWsl, node: nodeInWsl, cc: ccInWsl, authed: authedInWsl, vaultConfigured,
      wsl, pythonInWsl, nodeInWsl, ccInWsl, authedInWsl,
    };
  }

  // Mac / Linux
  const python = await checkBool("python3 --version");
  const node = await checkBool("node --version");
  const cc = node ? await checkBool("which claude") : false;
  const authed = cc ? await checkAuth("") : false;

  return { python, node, cc, authed, vaultConfigured };
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

function getMacSteps(deps: CCDeps): WizardStep | null {
  if (!deps.python) {
    return {
      title: "Install Python 3",
      desc: "Python 3 is required for Augment's terminal connection.",
      action: "terminal",
      actionLabel: "Install developer tools",
      terminalCmd: "xcode-select --install\n",
      secondaryLabel: "Download Python from python.org \u2197",
      secondaryUrl: "https://www.python.org/downloads/",
    };
  }
  if (!deps.node) {
    return {
      title: "Install Node.js",
      desc: "Node.js is required to install Claude Code. Download and run the installer from nodejs.org.",
      action: "link",
      actionLabel: "Open nodejs.org \u2197",
      actionUrl: "https://nodejs.org",
    };
  }
  if (!deps.cc) {
    return {
      title: "Install Claude Code",
      desc: "A terminal will open and install Claude Code automatically.",
      action: "terminal",
      actionLabel: "Install Claude Code",
      terminalCmd: "npm install -g @anthropic-ai/claude-code\n",
    };
  }
  if (!deps.authed) {
    return {
      title: "Sign in to Claude",
      desc: "A terminal will open and your browser will open for sign-in. Use the same account as claude.ai.",
      action: "terminal",
      actionLabel: "Sign in to Claude",
      terminalCmd: "claude auth login\n",
    };
  }
  if (!deps.vaultConfigured) {
    return {
      title: "Set up your vault",
      desc: "Creates a CLAUDE.md file so Claude Code understands your vault, and an agents/skills/ folder for agent skills.",
      action: "vault",
      actionLabel: "Set up vault",
    };
  }
  return null;
}

function getWindowsSteps(deps: CCDeps): WizardStep | null {
  if (!deps.wsl) {
    return {
      title: "Install WSL",
      desc: "Claude Code runs through Windows Subsystem for Linux (WSL). Open PowerShell as Administrator, run this command, and restart when prompted:",
      action: "copy",
      actionLabel: "Copy",
      copyText: "wsl --install",
    };
  }
  if (!deps.pythonInWsl) {
    return {
      title: "Install Python",
      desc: "Python 3 is required for Augment's terminal connection. A terminal will open and install Python inside WSL. You may be prompted for your WSL password.",
      action: "terminal",
      actionLabel: "Install Python",
      terminalCmd: "sudo apt update && sudo apt install -y python3\n",
    };
  }
  if (!deps.nodeInWsl) {
    return {
      title: "Install Node.js",
      desc: "Node.js is required to install Claude Code. A terminal will open and install Node.js inside WSL.",
      action: "terminal",
      actionLabel: "Install Node.js",
      terminalCmd: "sudo apt update && sudo apt install -y nodejs npm\n",
    };
  }
  if (!deps.ccInWsl) {
    return {
      title: "Install Claude Code",
      desc: "A terminal will open and install Claude Code inside WSL.",
      action: "terminal",
      actionLabel: "Install Claude Code",
      terminalCmd: "npm install -g @anthropic-ai/claude-code\n",
    };
  }
  if (!deps.authedInWsl) {
    return {
      title: "Sign in to Claude",
      desc: "A terminal will open and your browser will open for sign-in. Use the same account as claude.ai.",
      action: "terminal",
      actionLabel: "Sign in to Claude",
      terminalCmd: "claude auth login\n",
    };
  }
  if (!deps.vaultConfigured) {
    return {
      title: "Set up your vault",
      desc: "Creates a CLAUDE.md file so Claude Code understands your vault, and an agents/skills/ folder for agent skills.",
      action: "vault",
      actionLabel: "Set up vault",
    };
  }
  return null;
}

function getStepIndex(deps: CCDeps): { current: number; total: number } {
  const platform = process.platform;
  if (platform === "win32") {
    const total = 6;
    if (!deps.wsl) return { current: 1, total };
    if (!deps.pythonInWsl) return { current: 2, total };
    if (!deps.nodeInWsl) return { current: 3, total };
    if (!deps.ccInWsl) return { current: 4, total };
    if (!deps.authedInWsl) return { current: 5, total };
    if (!deps.vaultConfigured) return { current: 6, total };
    return { current: total, total };
  }
  const total = 5;
  if (!deps.python) return { current: 1, total };
  if (!deps.node) return { current: 2, total };
  if (!deps.cc) return { current: 3, total };
  if (!deps.authed) return { current: 4, total };
  if (!deps.vaultConfigured) return { current: 5, total };
  return { current: total, total };
}

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
      text: "Augment is designed for high-speed, in-editor continuation while also providing a deep integrated terminal system for running agents like Claude Code. Generate inline with Mod+Enter \u2014 context comes from your note title, frontmatter, everything above your cursor, and linked notes.",
    });

    // ── System 3 account ────────────────────────────────────────────────────
    overviewPane.createEl("h3", { cls: "augment-settings-header", text: "System 3 account" });

    // apiKeyWrapper declared here so renderS3Account can toggle its visibility.
    const apiKeyWrapper = overviewPane.createDiv();

    const s3AccountSetting = new Setting(overviewPane);
    const renderS3Account = () => {
      s3AccountSetting.clear();
      apiKeyWrapper.style.display = this.plugin.settings.s3Token ? "none" : "";
      if (this.plugin.settings.s3Token) {
        s3AccountSetting
          .setName(this.plugin.settings.s3Email || "Logged in")
          .setDesc("Generating via System 3 proxy \u2014 no API key needed.")
          .addButton((btn) => {
            btn.setButtonText("Log out").onClick(async () => {
              this.plugin.settings.s3Token = "";
              this.plugin.settings.s3Email = "";
              await this.plugin.saveData(this.plugin.settings);
              renderS3Account();
            });
          });
      } else {
        let emailVal = "";
        let passVal = "";
        s3AccountSetting
          .setName("Log in with Relay account")
          .setDesc("Relay subscribers get Augment included \u2014 no separate API key needed.")
          .addText((text) => {
            text.setPlaceholder("Email").inputEl.style.marginRight = "4px";
            text.inputEl.type = "email";
            text.onChange((v) => { emailVal = v; });
          })
          .addText((text) => {
            text.setPlaceholder("Password").inputEl.style.marginRight = "4px";
            text.inputEl.type = "password";
            text.onChange((v) => { passVal = v; });
          })
          .addButton((btn) => {
            btn.setButtonText("Log in").setCta().onClick(async () => {
              if (!emailVal || !passVal) {
                new Notice("Enter your email and password.");
                return;
              }
              btn.setButtonText("\u2026").setDisabled(true);
              try {
                const res = await fetch(
                  "https://auth.system3.md/api/collections/users/auth-with-password",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ identity: emailVal, password: passVal }),
                  }
                );
                if (!res.ok) {
                  const err = await res.json().catch(() => ({}));
                  new Notice(`Login failed: ${err.message ?? res.statusText}`);
                  console.log("[Augment] S3 login failed", res.status, err);
                  btn.setButtonText("Log in").setDisabled(false);
                  return;
                }
                const data = await res.json();
                this.plugin.settings.s3Token = data.token;
                this.plugin.settings.s3Email = data.record?.email ?? emailVal;
                await this.plugin.saveData(this.plugin.settings);
                renderS3Account();
              } catch (e) {
                new Notice("Login failed \u2014 check your connection.");
                console.log("[Augment] S3 login error", e);
                btn.setButtonText("Log in").setDisabled(false);
              }
            });
          });
      }
    };

    // Render S3 section before API key wrapper is populated (visibility set in renderS3Account).
    // apiKeyWrapper is already in the DOM above it — settings-tab builds top-down.
    overviewPane.insertBefore(s3AccountSetting.settingEl, apiKeyWrapper);
    renderS3Account();

    // API key (on Overview pane)
    const apiKeySetting = new Setting(apiKeyWrapper)
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

    new Setting(overviewPane)
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

    // ── Continuation pane ────────────────────────────────────
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
      .setDesc("Show a brief notice when generation starts. Helps confirm the hotkey fired.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showGenerationToast)
          .onChange(async (value) => {
            this.plugin.settings.showGenerationToast = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(continuationPane)
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
          console.log("[Augment] could not create template");
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
      text: "The Terminals panel runs Claude Code sessions alongside your notes. Open a terminal with the + button in the Terminals panel, or via the command palette.",
    });

    // Setup wizard section
    const wizardSection = terminalPane.createDiv({ cls: "augment-setup-card" });
    const wizardBody = wizardSection.createDiv();

    const setupVault = async () => {
      // Create CLAUDE.md at vault root if absent
      const claudeMdPath = "CLAUDE.md";
      if (!this.app.vault.getAbstractFileByPath(claudeMdPath)) {
        const templateFolder = this.plugin.settings.templateFolder || "Augment/templates";
        const content = `# Vault\n\nThis is my Obsidian vault.\n\n## Agent skills\n\nSkills live in \`agents/skills/\`. Run them with \`/[skill name]\` in any note (requires Augment).\n\n## Templates\n\nPrompt templates live in \`${templateFolder}\`. Run with Cmd+Shift+Enter.\n`;
        await this.app.vault.create(claudeMdPath, content);
      }

      // Create agents/skills/ folder if absent
      const skillsPath = "agents/skills";
      if (!this.app.vault.getAbstractFileByPath(skillsPath)) {
        await this.app.vault.createFolder(skillsPath);
      }
    };

    const renderWizard = async () => {
      wizardBody.empty();
      wizardBody.createDiv({ cls: "augment-cc-status-row augment-cc-muted", text: "Checking dependencies..." });

      const deps = await detectDeps(this.app);
      wizardBody.empty();

      const step = process.platform === "win32" ? getWindowsSteps(deps) : getMacSteps(deps);

      if (!step) {
        // All dependencies satisfied
        const ready = wizardBody.createDiv({ cls: "augment-cc-ready" });
        ready.createSpan({ cls: "augment-cc-ok", text: "\u2713" });
        ready.createSpan({ text: " All set. Claude Code is ready and your vault is configured." });
        const recheckLink = ready.createEl("a", { cls: "augment-cc-recheck", text: "Re-check \u21ba" });
        recheckLink.href = "#";
        recheckLink.addEventListener("click", (e) => {
          e.preventDefault();
          void renderWizard();
        });
        return;
      }

      const { current, total } = getStepIndex(deps);

      // Header
      const hdr = wizardBody.createDiv({ cls: "augment-setup-header" });
      hdr.createSpan({ cls: "augment-setup-title", text: "Set up Claude Code" });
      hdr.createSpan({ cls: "augment-setup-step-count", text: `Step ${current} of ${total}` });

      // Body
      const body = wizardBody.createDiv({ cls: "augment-setup-body" });
      body.createEl("div", { cls: "augment-setup-step-title", text: step.title });
      body.createEl("p", { cls: "augment-setup-step-desc", text: step.desc });

      // Actions
      const actions = body.createDiv({ cls: "augment-setup-actions" });

      if (step.action === "link") {
        const linkBtn = actions.createEl("button", { cls: "mod-cta", text: step.actionLabel });
        linkBtn.addEventListener("click", () => {
          window.open(step.actionUrl!, "_blank");
        });
      } else if (step.action === "terminal") {
        const termBtn = actions.createEl("button", { cls: "mod-cta", text: step.actionLabel });
        termBtn.addEventListener("click", async () => {
          const view = await this.plugin.openFocusedTerminal();
          setTimeout(() => view.write(step.terminalCmd!), 800);
        });
      } else if (step.action === "copy") {
        body.createEl("code", { cls: "augment-wsl-command", text: step.copyText! });
        const copyBtn = actions.createEl("button", { cls: "mod-cta", text: step.actionLabel });
        copyBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(step.copyText!);
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = step.actionLabel; }, 1500);
        });
      } else if (step.action === "vault") {
        const vaultBtn = actions.createEl("button", { cls: "mod-cta", text: step.actionLabel });
        vaultBtn.addEventListener("click", async () => {
          vaultBtn.textContent = "Setting up...";
          vaultBtn.disabled = true;
          await setupVault();
          void renderWizard();
        });
      }

      // Secondary link (e.g., python.org download)
      if (step.secondaryLabel && step.secondaryUrl) {
        const secLink = actions.createEl("a", {
          cls: "augment-folder-open",
          text: step.secondaryLabel,
        });
        secLink.href = step.secondaryUrl;
        secLink.target = "_blank";
        secLink.rel = "noopener";
      }

      // "Done — check ↺" link with 2s delay (not needed for vault action — it auto-advances)
      if (step.action !== "vault") {
        const recheck = body.createDiv({ cls: "augment-cc-recheck" });
        const recheckLink = recheck.createEl("a", { text: "Done \u2014 check \u21ba" });
        recheckLink.href = "#";
        recheckLink.addEventListener("click", (e) => {
          e.preventDefault();
          recheckLink.textContent = "Checking...";
          recheckLink.style.pointerEvents = "none";
          setTimeout(() => { void renderWizard(); }, 2000);
        });
      }
    };

    // Lazy detection — run when Terminal tab is first clicked.
    let wizardRan = false;
    wizardBody.createDiv({ cls: "augment-cc-status-row augment-cc-muted", text: "Click to check setup status" });
    terminalTab.addEventListener("click", () => {
      if (!wizardRan) {
        wizardRan = true;
        void renderWizard();
      }
    });

    // Configuration section label
    terminalPane.createDiv({ cls: "augment-section-label", text: "Configuration" });

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

    // Filesystem rename notice
    terminalPane.createEl("p", {
      cls: "augment-terminal-notice",
      text: "Claude Code reads and writes vault files directly via the filesystem. Do not use CC to rename or move files \u2014 use Obsidian\u2019s built-in rename to preserve wikilinks.",
    });

    // <!-- Advanced: Obsidian MCP server setup (v2) -->
  }
}
