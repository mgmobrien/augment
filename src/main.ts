import { Editor, MarkdownView, Modal, Notice, Plugin, Setting, TFile } from "obsidian";
import { applyOutputFormat, bestModelId, buildSystemPrompt, buildUserMessage, fetchModels, friendlyApiError, generateText, logApiDiagnostics, ModelInfo, modelDisplayName, substituteVariables } from "./ai-client";
import { AgentSuggest } from "./agent-suggest";
import { ContextInspectorView, VIEW_TYPE_CONTEXT_INSPECTOR } from "./context-inspector-view";
import { AugmentSettingTab } from "./settings-tab";
import { getTemplateFiles, TemplatePicker, TemplatePreviewModal } from "./template-picker";
import { assembleNoteContext, assembleVaultContext, AugmentSettings, ContextEntry, DEFAULT_SETTINGS, SessionRecord } from "./vault-context";
import { TerminalView, VIEW_TYPE_TERMINAL, cleanupXtermStyle } from "./terminal-view";
import { TerminalManagerView, VIEW_TYPE_TERMINAL_MANAGER } from "./terminal-manager-view";
import { TerminalSwitcherModal } from "./terminal-switcher";
import { Decoration, DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { EditorSelection, StateEffect, StateField } from "@codemirror/state";

// Default template files written to vault on first install
const SCAFFOLD_FOLDER = "Augment/templates";
const SCAFFOLD_TEMPLATES: [string, string][] = [
  [
    "Generate summary block",
    `---
name: Generate summary block
description: Write a concise summary of this note
---
Summarize the following note. Identify the core claim, key supporting ideas, and any open questions. Write 3\u20135 sentences.

Note: {{title}}

{{note_content}}
`,
  ],
  [
    "Synthesis from linked notes",
    `---
name: Synthesis from linked notes
description: Draw connections across notes linked from this one
---
The following notes are all linked from "{{title}}". Identify patterns, tensions, and connections across them. What do they add up to together?

{{linked_notes_full}}
`,
  ],
  [
    "Name this concept",
    `---
name: Name this concept
description: Suggest candidate names for the concept in this note
---
Read the following note. Suggest 3\u20135 candidate names for the concept it describes. Each name should be concise (2\u20134 words), memorable, and capture the essential idea.

Note: {{title}}

{{note_content}}
`,
  ],
];

// Default skills written to vault on first install.
// Each entry: [folder-name, SKILL.md content].
const SCAFFOLD_SKILLS_FOLDER = "agents/skills";
const SCAFFOLD_SKILLS: [string, string][] = [
  [
    "meeting-summary",
    `---
name: meeting-summary
description: Summarise a meeting transcript or rough notes into structured output
---

# Meeting summary

Read the note provided. It contains a meeting transcript, rough meeting notes, or a recording dump.

Produce a structured summary with these sections:

- **Attendees** (if identifiable)
- **Key points** — the main topics discussed, 1–2 sentences each
- **Decisions** — anything that was decided or agreed on
- **Action items** — who committed to what, with deadlines if mentioned
- **Open questions** — anything raised but not resolved

Write the summary as markdown. Be concise — the summary should be shorter than the source. Preserve specific names, dates, and numbers exactly as stated.

If the note is not a meeting transcript, say so and skip.
`,
  ],
  [
    "vault-search",
    `---
name: vault-search
description: Search the vault for notes relevant to a question and synthesise an answer
---

# Vault search

The user will ask a question or give a topic. Your job:

1. Use Grep and Glob to search the vault for relevant notes.
2. Read the most relevant hits (up to 10 notes).
3. Synthesise what you found into a clear answer, citing note titles as \`[[wikilinks]]\`.

If you find nothing relevant, say so. Do not fabricate content that isn't in the vault.

Keep the answer concise. Link to source notes so the user can read further.
`,
  ],
  [
    "clean-up",
    `---
name: clean-up
description: Tidy a rough note — fix formatting, add frontmatter, organise sections
---

# Clean up

Read the note provided. Clean it up:

- Fix markdown formatting (headings, lists, code blocks)
- Add or complete frontmatter if missing (at minimum: a descriptive title)
- Organise content into logical sections with headings
- Fix obvious typos and grammatical errors
- Remove redundant whitespace or broken formatting

Preserve the original meaning and voice. Do not add new content or opinions. Do not delete substantive content — only remove formatting artifacts.

Edit the file directly. Show what you changed.
`,
  ],
  [
    "stack-setup",
    `---
name: stack-setup
description: Vault architect \u2014 assesses vault against S3 reference model, closes gaps
---

# Stack setup

You are the System 3 vault architect. You know the target vault structure (the S3 reference model below) and your job is to: (1) scan the current vault, (2) compare it against the reference model, (3) close gaps by creating missing structure, and (4) report what you did.

This skill is idempotent. Running it twice produces the same result. It never deletes or overwrites existing content.

## S3 reference model

This is the target state for a System 3 vault. Not every vault needs every piece \u2014 adapt to the user's scale and domain. But this is what "fully configured" looks like.

### Folder structure

\`\`\`
agents/                    # Canonical home for skills and parts
  skills/                  # Agent skills (each skill = folder with SKILL.md)
  parts/                   # Part workspaces (state + sessions)
claude/                    # Claude Code config (CLAUDE.md, settings)
  skills/ -> ../agents/skills/   # Symlink for CC working directory
.claude/ -> claude/        # Symlink (CC expects .claude/)
Daily Notes/               # Daily planning and reflection
  YYYY Daily Notes/        # Year subfolders
    YYYY-MM Daily Notes/   # Month subfolders within year
Inbox/                     # Quick capture and processing
z.Templates/               # Note templates
  v2 templates/            # Current template generation
Augment/                   # Augment plugin workspace
  templates/               # Prompt templates for Augment
\`\`\`

Optional domain folders (create based on user's needs):
- Projects/ \u2014 project tracking
- Meetings/ \u2014 meeting notes
- Research/ \u2014 reference material and research

### CLAUDE.md

The vault root must have a CLAUDE.md (or claude/CLAUDE.md with .claude/ symlink). This is the AI instruction file. It should contain:

1. **Vault description**: what this vault is for
2. **Folder map**: key directories and their purpose
3. **Convention guidance**: wikilinks for internal links, frontmatter on all notes, sentence case for headings
4. **Skills reference**: skills live at agents/skills/{name}/SKILL.md
5. **Templates reference**: prompt templates location
6. **Writing style**: any user-specific writing preferences

### Frontmatter conventions

Every note should have frontmatter. The S3 standard fields:

\`\`\`yaml
---
note created: YYYY-MM-DD Day        # Creation date with day-of-week
note creators: []                    # Who created it (user name, [[Gus|model]])
type: note                           # Note type (note, meeting, project, etc.)
tags: []                             # Categorization tags
aliases: []                          # Alternative names for wikilink resolution
relatives: []                        # Structural links to related notes
---
\`\`\`

Minimal starter convention (for vaults without existing frontmatter):
\`\`\`yaml
---
type: note
tags: []
---
\`\`\`

### Skills

Each skill is a folder under agents/skills/ containing a SKILL.md file:

\`\`\`
agents/skills/{skill-name}/SKILL.md
\`\`\`

SKILL.md frontmatter:
\`\`\`yaml
---
name: skill-name
description: What the skill does (one line)
user_invocable: true                 # Shows in slash command picker
---
\`\`\`

Body contains instructions for Claude Code when the skill is invoked.

### Symlink strategy

The vault uses symlinks so that Claude Code's expected paths (.claude/) and the vault's canonical paths (agents/, claude/) both work:

- \`.claude/\` \u2192 \`claude/\` (CC config)
- \`claude/skills/\` \u2192 \`../agents/skills/\` (skills accessible from CC working dir)

Create these symlinks if missing. On Windows, skip symlinks and document the paths in CLAUDE.md instead.

### Daily notes

Daily notes use the format: \`YYYY-MM-DD Day.md\` (e.g., \`2026-03-04 Tue.md\`)
Stored in: \`Daily Notes/YYYY Daily Notes/YYYY-MM Daily Notes/\`

If the user has a different daily note convention, document it in CLAUDE.md rather than changing it.

### Linking conventions

- **Internal links**: wikilinks (\`[[Note name]]\`), not markdown links
- **Heading style**: sentence case, not Title Case
- **Log entries in daily notes**: collapsed callouts (\`> [!ai]- Summary\`)
- **Log entries in other notes**: H3 headings with timestamp

## Execution

### Phase 1: Vault scan

Scan the vault to understand its current state. Collect:

1. **Top-level folders** (skip .obsidian, .trash, .git)
2. **Frontmatter survey**: sample 15\u201320 recent .md files. Collect type values, common tags, recurring keys, consistency level
3. **Note count and type distribution**: top 5 types by count
4. **Linking style**: wikilinks vs markdown links vs mixed
5. **Existing config**: does CLAUDE.md exist? agents/ folder? symlinks? daily notes pattern?

### Phase 2: Gap assessment

Compare the scan results against the S3 reference model. For each component, classify as:
- **Present**: matches reference model
- **Partial**: exists but incomplete
- **Missing**: not present
- **Divergent**: exists but follows a different convention (do not change \u2014 document)

Print the gap assessment as a checklist.

### Phase 3: Close gaps

For each missing or partial item, take action:

1. **CLAUDE.md**: create if missing, or append missing sections to existing file. Never modify existing content.
2. **Folder structure**: create missing folders (agents/skills/, Augment/templates/, Inbox/, etc.)
3. **Symlinks**: create .claude/ \u2192 claude/ and claude/skills/ \u2192 ../agents/skills/ if missing
4. **Frontmatter guidance**: if fewer than half of sampled notes have frontmatter, add a "Frontmatter conventions" section to CLAUDE.md with the recommended pattern. Do not modify existing notes.
5. **Starter skills**: if agents/skills/ is empty, the Augment plugin will scaffold default skills on next reload. Note this in the report.

For divergent items: do not change them. Document the user's convention in CLAUDE.md so the AI respects it.

### Phase 4: Template generation (System 3 account required)

Check \`.obsidian/plugins/augment-terminal/data.json\` for a non-empty \`s3Token\` field.

**If S3 login exists**: generate 2\u20133 prompt templates tailored to the vault profile. Each template:
- Addresses a pattern found in the scan (e.g., many meeting notes \u2192 meeting template)
- Uses Handlebars variables: \`{{title}}\`, \`{{note_content}}\`, \`{{frontmatter.KEY}}\`, \`{{linked_notes}}\`
- Has frontmatter: \`name:\`, \`description:\` (append " (generated)"), optionally \`system_prompt:\`
- Written to the templates folder. Skip if same-name file exists.

**If no S3 login**: suggest 2\u20133 template ideas the user could create. Explain purpose and variables.

### Phase 5: Status report

Print a summary with four sections:
1. **Created**: what was added
2. **Skipped**: what was already configured
3. **Documented**: divergent conventions recorded in CLAUDE.md
4. **Next steps**: actionable suggestions (e.g., "Try Mod+Enter in any note", "Run /meeting-summary on a transcript", "Add frontmatter to your most-used notes")

## Principles

- **Idempotent**: running twice produces the same result. Never duplicate.
- **Non-destructive**: never delete or overwrite existing files or content.
- **Respect divergence**: if the user's convention differs from S3, document it \u2014 don't fight it.
- **Fast**: under 30 seconds. Do not do unnecessary work.
`,
  ],
];

// CM6 spinner widget — inserts an HTML triangle animation at cursor without modifying document text
const addSpinnerEffect = StateEffect.define<number>();
const removeSpinnerEffect = StateEffect.define<null>();

class SpinnerWidget extends WidgetType {
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "augment-spinner";
    for (const cls of ["augment-dot-red", "augment-dot-green", "augment-dot-blue"]) {
      const dot = document.createElement("span");
      dot.className = "augment-spinner-dot " + cls;
      wrap.appendChild(dot);
    }
    return wrap;
  }
  ignoreEvent(): boolean { return true; }
}

// Effect dispatched when backspace/escape cancels a generation.
// The plugin listens for this to abort the in-flight fetch.
const cancelGenerationEffect = StateEffect.define<null>();

const spinnerField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addSpinnerEffect)) {
        decos = decos.update({ add: [Decoration.widget({ widget: new SpinnerWidget(), side: -1 }).range(e.value)] });
      } else if (e.is(removeSpinnerEffect)) {
        decos = Decoration.none;
      }
    }
    // Detect document deletions near the spinner position — treat as cancel.
    if (decos !== Decoration.none && tr.docChanged) {
      let spinnerPos = -1;
      const cursor = decos.iter();
      if (cursor.value) spinnerPos = cursor.from;
      if (spinnerPos >= 0) {
        let deleted = false;
        tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
          // Only cancel on deletions (removed > inserted) that touch the spinner position.
          // Insertions (Enter, typing) have toA === fromA — ignore those.
          const removedLen = toA - fromA;
          const insertedLen = toB - fromB;
          if (removedLen > 0 && insertedLen < removedLen && toA >= spinnerPos && fromA <= spinnerPos) deleted = true;
        });
        if (deleted) {
          // Schedule cancel effect on the next microtask to avoid dispatching during update.
          const view = (tr as any).view ?? (tr.state.field as any)?._view;
          // We'll use a safer approach — store a flag and let the plugin pick it up.
          Promise.resolve().then(() => {
            try {
              // Find the EditorView from the transaction — CM6 doesn't expose it directly
              // on the transaction, so we look for the active generation's cmView.
              (globalThis as any).__augmentCancelGeneration?.();
            } catch { /* ignore */ }
          });
        }
      }
    }
    return decos;
  },
  provide: f => EditorView.decorations.from(f),
});

// ── Persistent agent status widget (skill invocation) ──
const addAgentWidgetEffect = StateEffect.define<{ pos: number; name: string }>();
const removeAgentWidgetEffect = StateEffect.define<null>();

class AgentWidget extends WidgetType {
  constructor(private name: string) { super(); }
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "augment-agent-widget";
    const spinner = document.createElement("span");
    spinner.className = "augment-spinner";
    for (const cls of ["augment-dot-red", "augment-dot-green", "augment-dot-blue"]) {
      const dot = document.createElement("span");
      dot.className = "augment-spinner-dot " + cls;
      spinner.appendChild(dot);
    }
    wrap.appendChild(spinner);
    wrap.appendChild(document.createTextNode("\u00a0" + this.name));
    return wrap;
  }
  ignoreEvent(): boolean { return true; }
}

const agentWidgetField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addAgentWidgetEffect)) {
        decos = decos.update({
          add: [Decoration.widget({ widget: new AgentWidget(e.value.name), side: 1 }).range(e.value.pos)],
        });
      } else if (e.is(removeAgentWidgetEffect)) {
        decos = Decoration.none;
      }
    }
    return decos;
  },
  provide: f => EditorView.decorations.from(f),
});

type TeamCreateSpawnEvent = {
  sourceName?: string;
  team?: string;
  members?: string[];
};

class RenameModal extends Modal {
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

function buildWelcomeNoteContent(mod: string): string {
  return `# Get started with Augment

Augment adds AI-powered writing continuation and Claude Code terminal sessions to Obsidian. This note walks you through everything.

---

## 1. Add your API key

You need a console API key from [console.anthropic.com/settings/api-keys](https://console.anthropic.com/settings/api-keys) — not your Claude.ai login.

> [!warning] Claude Max/Pro subscriptions don't work here
> Anthropic prohibits OAuth tokens in third-party tools (Feb 2026). You need a pay-per-token key starting with \`sk-ant-api03-\`. Billing is separate from any subscription.

Open settings: **${mod}+,** → Augment in the left sidebar → Overview tab. Add your key there, then come back.

---

## 2. Continuation (${mod}+Enter)

Augment reads your note title, frontmatter, the text above your cursor, and any linked notes — then continues from where your cursor is. Output goes directly below your cursor.

**Try it.** Put your cursor at the end of the line below and press ${mod}+Enter:

The most interesting thing about writing in plain text is

---

## 3. Template picker (${mod}+Shift+Enter)

Instead of free continuation, templates run a specific prompt on your current note — useful for recurring tasks: summarise, extract action items, rewrite in a different register.

**Try it:** Press **${mod}+Shift+Enter** to open the template picker.

Templates are \`.md\` files in your templates folder (\`Augment/templates/\` by default). Configure the folder in Settings → Templates. Each template can define a custom system prompt via \`system_prompt:\` in its frontmatter.

---

## 4. Context inspector

The context inspector shows exactly what Augment sent to the AI: system prompt, this note's content, linked notes, and a token estimate per section. It updates live as you write.

**Open it:** Command palette → \`Augment: Open context inspector\`

The panel opens in your right sidebar. Use it to understand why the AI responded the way it did, or to check your context budget before generating.

---

## 5. Right-click menu

Right-clicking in any note gives you quick access without shortcuts:
- **Augment: Generate** — same as ${mod}+Enter
- **Augment: Generate from template…** — same as ${mod}+Shift+Enter

---

## 6. Claude Code terminal sessions

Augment can host Claude Code agent sessions in a panel alongside your notes. Each session runs a full CC conversation with access to your vault.

**Set it up:** Settings → Terminal → follow the guided setup wizard (installs Python, Node.js, CC CLI, and configures your vault).

---

*This note lives at \`Augment/Get started.md\`. Reopen it any time: command palette → \`Augment: Open welcome\`.*
`;
}

export default class AugmentTerminalPlugin extends Plugin {
  settings: AugmentSettings = { ...DEFAULT_SETTINGS };
  public availableModels: ModelInfo[] = [];
  public contextHistory: ContextEntry[] = [];
  private recentTeamCreateSpawnSignatures: Map<string, number> = new Map();
  private calloutStyleEl: HTMLStyleElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private activeGeneration: {
    abortController: AbortController;
    cmView: EditorView;
    insertPos: number;
  } | null = null;

  // Returns the actual model ID to use, resolving "auto" to the best available.
  public resolveModel(): string {
    if (this.settings.model !== "auto") return this.settings.model;
    return bestModelId(this.availableModels) ?? "claude-opus-4-6";
  }

  // Display name for the resolved model — used in status bar and output formats.
  public resolveModelDisplayName(): string {
    const id = this.resolveModel();
    const found = this.availableModels.find(m => m.id === id);
    return found?.display_name ?? modelDisplayName(id);
  }

  public refreshStatusBar(): void {
    if (!this.statusBarEl) return;
    if (!this.settings.apiKey) {
      this.statusBarEl.setText("Augment: API key needed");
    } else {
      this.statusBarEl.setText(`Augment: ${this.resolveModelDisplayName()}`);
    }
  }

  private cancelGeneration(): void {
    const gen = this.activeGeneration;
    if (!gen) return;
    gen.abortController.abort();
    gen.cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
    // Restore cursor to the generation start position.
    gen.cmView.dispatch({ selection: EditorSelection.cursor(Math.min(gen.insertPos, gen.cmView.state.doc.length)) });
    this.activeGeneration = null;
    this.refreshStatusBar();
    console.log("[Augment] generation cancelled");
    new Notice("Augment: generation cancelled");
  }

  private triggerGenerate(editor: Editor): void {
    const cursor = editor.getCursor();
    const aboveCursor = editor.getRange({ line: 0, ch: 0 }, cursor);
    const promptText = aboveCursor.trim() || editor.getValue().trim();
    const ctx = assembleVaultContext(this.app, editor, this.settings);

    if (this.statusBarEl) {
      this.statusBarEl.empty();
      const sbSpinner = this.statusBarEl.createEl("span", { cls: "augment-sb-spinner" });
      sbSpinner.createEl("span", { cls: "augment-sb-dot" });
      sbSpinner.createEl("span", { cls: "augment-sb-dot" });
      sbSpinner.createEl("span", { cls: "augment-sb-dot" });
      this.statusBarEl.createEl("span", { text: " generating" });
    }
    if (this.settings.showGenerationToast) {
      new Notice("Generating\u2026", 3000);
    }

    const isBlock = this.settings.outputFormat !== "plain";
    let insertPos: number;
    if (isBlock && cursor.ch > 0) {
      editor.replaceRange("\n", cursor);
      insertPos = editor.posToOffset({ line: cursor.line + 1, ch: 0 });
    } else {
      insertPos = editor.posToOffset(cursor);
    }

    const cmView = (editor as any).cm as EditorView;
    cmView.dispatch({ effects: addSpinnerEffect.of(insertPos), selection: EditorSelection.cursor(insertPos, 1) });

    const abortController = new AbortController();
    this.activeGeneration = { abortController, cmView, insertPos };

    void (async () => {
      try {
        const resolvedModel = this.resolveModel();
        const resolvedModelName = this.resolveModelDisplayName();
        const result = await generateText(buildSystemPrompt(ctx, this.settings.systemPrompt || undefined), promptText, this.settings, resolvedModel, abortController.signal);
        this.activeGeneration = null;
        cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
        const formatted = applyOutputFormat(result, this.settings, resolvedModelName);
        const insertPosLine = editor.offsetToPos(insertPos);
        if (isBlock) {
          const withTrail = formatted + "\n";
          editor.replaceRange(withTrail, insertPosLine);
          const lines = withTrail.split("\n");
          editor.setCursor({ line: insertPosLine.line + lines.length - 1, ch: 0 });
        } else {
          editor.replaceRange(formatted, insertPosLine);
        }
        const entry: ContextEntry = {
          timestamp: Date.now(),
          noteName: ctx.title,
          model: resolvedModelName,
          systemPrompt: buildSystemPrompt(ctx, this.settings.systemPrompt || undefined),
          userMessage: buildUserMessage(ctx, promptText),
        };
        this.pushContextHistory(entry);
        console.log("[Augment] generation done");
        const notice = new Notice("", 5000);
        notice.noticeEl.empty();
        notice.noticeEl.createEl("span", { text: "Augment: done" });
        notice.noticeEl.createEl("span", { cls: "augment-notice-sep", text: " \u00b7 " });
        const viewLink = notice.noticeEl.createEl("a", { cls: "augment-notice-action", text: "view context" });
        viewLink.href = "#";
        viewLink.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          notice.hide();
          this.openContextInspector();
        });
        if (!this.settings.hasGenerated) {
          this.settings.hasGenerated = true;
          await this.saveData(this.settings);
        }
      } catch (err) {
        if (this.activeGeneration?.abortController === abortController) {
          // Aborted by cancel — already handled, just clean up.
          this.activeGeneration = null;
        }
        if (abortController.signal.aborted) return; // Cancel — no error notice.
        console.error("[Augment] generation failed", err);
        logApiDiagnostics(err, this.settings.apiKey, this.resolveModel());
        cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
        const errMsg = friendlyApiError(err) ?? (err instanceof Error ? err.message : String(err));
        new Notice(`Augment: ${errMsg}`);
      } finally {
        this.refreshStatusBar();
      }
    })();
  }

  private pushContextHistory(entry: ContextEntry): void {
    this.contextHistory.push(entry);
    if (this.contextHistory.length > 5) this.contextHistory.shift();
  }

  private async loadAvailableModels(): Promise<void> {
    if (!this.settings.apiKey) return;
    this.availableModels = await fetchModels(this.settings.apiKey);
    // Refresh status bar in case "auto" now resolves to a fetched model name.
    this.refreshStatusBar();
  }

  async clearObsidianLinkHotkey(): Promise<void> {
    const CONFLICT_IDS = ["editor:cycle-list-checklist", "editor:open-link-in-new-leaf"];
    try {
      const hotkeyPath = ".obsidian/hotkeys.json";
      let hotkeys: Record<string, unknown> = {};
      try {
        const raw = await this.app.vault.adapter.read(hotkeyPath);
        hotkeys = JSON.parse(raw);
      } catch { /* file may not exist yet */ }
      // Capture originals before overwriting so restore is exact.
      const originals: Record<string, unknown> = {};
      for (const id of CONFLICT_IDS) {
        if (id in hotkeys) originals[id] = hotkeys[id];
        hotkeys[id] = [];
      }
      await this.app.vault.adapter.write(hotkeyPath, JSON.stringify(hotkeys, null, 2));
      (this.app as any).hotkeyManager?.load?.();
      this.settings.clearedLinkHotkey = true;
      this.settings.clearedHotkeyOriginals = originals;
      await this.saveData(this.settings);
    } catch (e) {
      console.warn("[Augment] could not clear link hotkey:", e);
    }
  }

  async restoreObsidianLinkHotkey(): Promise<void> {
    const CONFLICT_IDS = ["editor:cycle-list-checklist", "editor:open-link-in-new-leaf"];
    try {
      const hotkeyPath = ".obsidian/hotkeys.json";
      let hotkeys: Record<string, unknown> = {};
      try {
        const raw = await this.app.vault.adapter.read(hotkeyPath);
        hotkeys = JSON.parse(raw);
      } catch { /* file may not exist */ }
      const originals = this.settings.clearedHotkeyOriginals ?? {};
      for (const id of CONFLICT_IDS) {
        if (id in originals) {
          hotkeys[id] = originals[id]; // restore exact original value
        } else {
          delete hotkeys[id]; // wasn't customised before — remove Augment's entry
        }
      }
      await this.app.vault.adapter.write(hotkeyPath, JSON.stringify(hotkeys, null, 2));
      (this.app as any).hotkeyManager?.load?.();
      this.settings.clearedLinkHotkey = false;
      this.settings.clearedHotkeyOriginals = {};
      await this.saveData(this.settings);
    } catch (e) {
      console.warn("[Augment] could not restore link hotkey:", e);
    }
  }

  private showHotkeyClaimedNotice(): void {
    const notice = new Notice("", 0);
    notice.noticeEl.empty();
    notice.noticeEl.createEl("span", { text: "Augment claimed Ctrl+Enter \u2014 " });
    const link = notice.noticeEl.createEl("a", { text: "Restore Obsidian\u2019s default", href: "#" });
    link.style.color = "var(--text-accent)";
    link.style.cursor = "pointer";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      notice.hide();
      (this.app as any).setting?.open?.();
      (this.app as any).setting?.openTabById?.("augment-terminal");
    });
  }

  private async scaffoldDefaultTemplates(): Promise<void> {
    const targetFolder = this.settings.templateFolder || SCAFFOLD_FOLDER;

    // Create folder if absent.
    if (!this.app.vault.getAbstractFileByPath(targetFolder)) {
      try { await this.app.vault.createFolder(targetFolder); } catch { /* already exists */ }
    }

    // Ensure templateFolder setting is saved.
    if (!this.settings.templateFolder) {
      this.settings.templateFolder = targetFolder;
      await this.saveData(this.settings);
    }

    // Write each default template if its file doesn't exist yet.
    // Never overwrite existing files — user edits are preserved.
    // New defaults added in future versions will be seeded into existing vaults.
    for (const [name, content] of SCAFFOLD_TEMPLATES) {
      const path = `${targetFolder}/${name}.md`;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        try { await this.app.vault.create(path, content); } catch { /* already exists */ }
      }
    }

    // Set templateFolder so the picker finds the scaffolded files.
    this.settings.templateFolder = targetFolder;
    await this.saveData(this.settings);
  }

  private async scaffoldDefaultSkills(): Promise<void> {
    // Create top-level folder if absent.
    if (!this.app.vault.getAbstractFileByPath(SCAFFOLD_SKILLS_FOLDER)) {
      try { await this.app.vault.createFolder(SCAFFOLD_SKILLS_FOLDER); } catch { /* already exists */ }
    }

    for (const [folderName, content] of SCAFFOLD_SKILLS) {
      const skillFolder = `${SCAFFOLD_SKILLS_FOLDER}/${folderName}`;
      if (!this.app.vault.getAbstractFileByPath(skillFolder)) {
        try { await this.app.vault.createFolder(skillFolder); } catch { /* already exists */ }
      }
      const skillPath = `${skillFolder}/SKILL.md`;
      if (!this.app.vault.getAbstractFileByPath(skillPath)) {
        try { await this.app.vault.create(skillPath, content); } catch { /* already exists */ }
      }
    }
  }

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // If clearedLinkHotkey was set on Mac by an older build (before the darwin guard existed),
    // auto-restore the hotkeys and reset the flag.
    if (this.settings.clearedLinkHotkey && process.platform === "darwin") {
      void this.restoreObsidianLinkHotkey();
    }

    // On Windows/Linux, auto-clear Obsidian's conflicting Ctrl+Enter default on first install,
    // then fire a Notice so the user knows what changed and can restore if needed.
    if (!this.settings.clearedLinkHotkey && process.platform !== "darwin") {
      void this.clearObsidianLinkHotkey().then(() => this.showHotkeyClaimedNotice());
    }

    // Scaffold defaults on first install (fire-and-forget — doesn't block onload).
    void this.scaffoldDefaultTemplates();
    void this.scaffoldDefaultSkills();

    // Fetch available models in the background — populates the model dropdown
    // and resolves "auto" to the best available model name in the status bar.
    void this.loadAvailableModels();

    this.calloutStyleEl = document.head.createEl("style");
    this.calloutStyleEl.id = "augment-callout-styles";
    this.calloutStyleEl.textContent = [
      `.callout[data-callout="ai"] { --callout-icon: bot; --callout-color: 139, 92, 246; }`,
      `.callout[data-callout="ai"] .callout-icon { display: flex !important; }`,
      `.callout[data-callout="ai"] .callout-title::before { content: "" !important; display: none !important; }`,
    ].join("\n");

    // Register views
    this.registerView(VIEW_TYPE_TERMINAL, (leaf) => {
      const view = new TerminalView(
        leaf,
        this.getPluginDir(),
        () => this.settings.useWsl,
        () => this.settings.pythonPath,
        () => this.settings.shellPath,
        () => this.settings.defaultWorkingDirectory
      );
      view.onSessionExit = (name, status, startedAt, skillName) => {
        this.appendSessionRecord(name, status, startedAt, skillName);
      };
      view.onAutoRenameRequest = async (excerpt: string) => {
        try {
          const raw = await generateText(
            "Generate a short descriptive name for this Claude Code terminal session based on the output excerpt. Use 2–4 lowercase words separated by hyphens. Respond with ONLY the name, nothing else.",
            `Session excerpt:\n${excerpt}`,
            this.settings,
            "claude-haiku-4-5-20251001"
          );
          const cleaned = raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, 40);
          return cleaned || null;
        } catch {
          return null;
        }
      };
      return view;
    });
    this.registerView(VIEW_TYPE_TERMINAL_MANAGER, (leaf) => {
      return new TerminalManagerView(leaf);
    });
    this.registerView(VIEW_TYPE_CONTEXT_INSPECTOR, (leaf) => {
      return new ContextInspectorView(leaf, this);
    });
    // Escape key cancels in-progress generation.
    const escapeKeymap = keymap.of([{
      key: "Escape",
      run: () => {
        if (this.activeGeneration) {
          this.cancelGeneration();
          return true;
        }
        return false;
      },
    }]);

    this.registerEditorExtension([spinnerField, agentWidgetField, escapeKeymap]);

    // Global cancel callback for the spinnerField's backspace detection.
    (globalThis as any).__augmentCancelGeneration = () => this.cancelGeneration();

    const agentSuggest = new AgentSuggest(this.app);
    this.registerEditorSuggest(agentSuggest);
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => agentSuggest.reload())
    );

    // AI generation commands
    this.addCommand({
      id: "augment-generate",
      name: "Generate",
      hotkeys: [{ modifiers: ["Mod"], key: "Enter" }],
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          console.log("[Augment] no active note for generate");
          new Notice("Open a note to generate");
          return;
        }
        if (!this.settings.apiKey) {
          console.log("[Augment] API key required");
          const notice = new Notice("Augment: API key required \u2014 click to open settings", 0);
          notice.noticeEl.style.cursor = "pointer";
          notice.noticeEl.addEventListener("click", () => {
            notice.hide();
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
          });
          return;
        }
        this.triggerGenerate(view.editor);
      },
    });

    this.addCommand({
      id: "augment-generate-from-template",
      name: "Generate from template",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }],
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          console.log("[Augment] no active note for generate-from-template");
          new Notice("Open a note to generate");
          return;
        }
        const editor = view.editor;
        if (!this.settings.apiKey) {
          console.log("[Augment] API key required");
          const notice = new Notice("Augment: API key required \u2014 click to open settings", 0);
          notice.noticeEl.style.cursor = "pointer";
          notice.noticeEl.addEventListener("click", () => {
            notice.hide();
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
          });
          return;
        }
        if (!this.settings.templateFolder) {
          console.log("[Augment] no template folder set");
          const notice = new Notice("Augment: no template folder set \u2014 click to configure", 0);
          notice.noticeEl.style.cursor = "pointer";
          notice.noticeEl.addEventListener("click", () => {
            notice.hide();
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
          });
          return;
        }
        const files = getTemplateFiles(this.app, this.settings.templateFolder);
        if (files.length === 0) {
          console.log("[Augment] no templates found in", this.settings.templateFolder);
          new Notice(`Augment: no templates found in ${this.settings.templateFolder}`);
          return;
        }
        const cursor = editor.getCursor();
        const ctx = assembleVaultContext(this.app, editor, this.settings);
        new TemplatePicker(this.app, files, async (templateFile) => {
          const templateContent = await this.app.vault.read(templateFile);

          // Read system_prompt override and output routing from template frontmatter.
          const templateFm = this.app.metadataCache.getFileCache(templateFile)?.frontmatter;
          const systemPromptOverride = typeof templateFm?.system_prompt === "string"
            ? templateFm.system_prompt
            : undefined;
          // target: "cursor" (default) | "clipboard" | "file" | "frontmatter"
          const targetMode: string = typeof templateFm?.target === "string" ? templateFm.target : "cursor";
          const targetFilePath: string | null = typeof templateFm?.target_file === "string" ? templateFm.target_file : null;
          const targetField: string | null = typeof templateFm?.target_field === "string" ? templateFm.target_field : null;

          // Lazy full-content reads — only when the template actually uses the variables.
          if (templateContent.includes("{{note_content}}")) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) ctx.content = await this.app.vault.read(activeFile);
          }
          if (templateContent.includes("{{linked_notes_full}}")) {
            for (const note of ctx.linkedNotes) {
              const file = this.app.vault.getFiles().find((f) => f.basename === note.title);
              if (file) {
                try { note.content = await this.app.vault.read(file); } catch { /* skip */ }
              }
            }
          }

          const rendered = substituteVariables(templateContent, ctx);

          const runGenerate = async () => {
            if (this.statusBarEl) {
              this.statusBarEl.empty();
              const sbSpinner = this.statusBarEl.createEl("span", { cls: "augment-sb-spinner" });
              sbSpinner.createEl("span", { cls: "augment-sb-dot" });
              sbSpinner.createEl("span", { cls: "augment-sb-dot" });
              sbSpinner.createEl("span", { cls: "augment-sb-dot" });
              this.statusBarEl.createEl("span", { text: " generating" });
            }

            const isCursorMode = targetMode === "cursor";
            const isBlock = this.settings.outputFormat !== "plain";
            let insertPos = 0;
            const cmView = (editor as any).cm as EditorView;

            if (isCursorMode) {
              if (isBlock && cursor.ch > 0) {
                editor.replaceRange("\n", cursor);
                insertPos = editor.posToOffset({ line: cursor.line + 1, ch: 0 });
              } else {
                insertPos = editor.posToOffset(cursor);
              }
              cmView.dispatch({ effects: addSpinnerEffect.of(insertPos), selection: EditorSelection.cursor(insertPos, 1) });
            }

            const abortController = new AbortController();
            this.activeGeneration = { abortController, cmView, insertPos };

            try {
              const resolvedModel = this.resolveModel();
              const resolvedModelName = this.resolveModelDisplayName();
              const result = await generateText(buildSystemPrompt(ctx, systemPromptOverride), rendered, this.settings, resolvedModel, abortController.signal);
              this.activeGeneration = null;
              if (isCursorMode) cmView.dispatch({ effects: removeSpinnerEffect.of(null) });

              // Route output
              if (targetMode === "clipboard") {
                await navigator.clipboard.writeText(result);
                new Notice("Augment: copied to clipboard", 5000);
              } else if (targetMode === "file" && targetFilePath) {
                const destFile = this.app.vault.getAbstractFileByPath(targetFilePath);
                if (destFile instanceof TFile) {
                  const prev = await this.app.vault.read(destFile);
                  await this.app.vault.modify(destFile, prev + "\n\n" + result);
                } else {
                  const parentFolder = targetFilePath.includes("/")
                    ? targetFilePath.slice(0, targetFilePath.lastIndexOf("/"))
                    : null;
                  if (parentFolder && !this.app.vault.getAbstractFileByPath(parentFolder)) {
                    try { await this.app.vault.createFolder(parentFolder); } catch { /* ignore */ }
                  }
                  await this.app.vault.create(targetFilePath, result);
                }
                const shortName = targetFilePath.split("/").pop() ?? targetFilePath;
                new Notice(`Augment: appended to ${shortName}`, 5000);
              } else if (targetMode === "frontmatter" && targetField) {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                  await this.app.fileManager.processFrontMatter(activeFile, (fm) => {
                    fm[targetField!] = result;
                  });
                }
                new Notice(`Augment: wrote to frontmatter.${targetField}`, 5000);
              } else {
                // cursor (default)
                const formatted = applyOutputFormat(result, this.settings, resolvedModelName);
                const insertPosLine = editor.offsetToPos(insertPos);
                if (isBlock) {
                  const withTrail = formatted + "\n";
                  editor.replaceRange(withTrail, insertPosLine);
                  const lines = withTrail.split("\n");
                  editor.setCursor({ line: insertPosLine.line + lines.length - 1, ch: 0 });
                } else {
                  editor.replaceRange(formatted, insertPosLine);
                }
                console.log("[Augment] template generation done");
                const notice = new Notice("", 5000);
                notice.noticeEl.empty();
                notice.noticeEl.createEl("span", { text: "Augment: done" });
                notice.noticeEl.createEl("span", { cls: "augment-notice-sep", text: " \u00b7 " });
                const viewLink = notice.noticeEl.createEl("a", { cls: "augment-notice-action", text: "view context" });
                viewLink.href = "#";
                viewLink.addEventListener("click", (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  notice.hide();
                  this.openContextInspector();
                });
              }

              // Common post-generation tracking (all targets)
              const entry: ContextEntry = {
                timestamp: Date.now(),
                noteName: ctx.title,
                model: resolvedModelName,
                systemPrompt: buildSystemPrompt(ctx, systemPromptOverride),
                userMessage: rendered,
              };
              this.pushContextHistory(entry);
              if (!this.settings.hasGenerated) {
                this.settings.hasGenerated = true;
                await this.saveData(this.settings);
              }
              if (!this.settings.hasUsedTemplate) {
                this.settings.hasUsedTemplate = true;
                await this.saveData(this.settings);
              }
            } catch (err) {
              if (this.activeGeneration?.abortController === abortController) {
                this.activeGeneration = null;
              }
              if (abortController.signal.aborted) return;
              console.error("[Augment] template generation failed", err);
              logApiDiagnostics(err, this.settings.apiKey, this.resolveModel());
              if (isCursorMode) cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
              const errMsg = friendlyApiError(err) ?? (err instanceof Error ? err.message : String(err));
              new Notice(`Augment: ${errMsg}`);
            } finally {
              this.refreshStatusBar();
            }
          };

          if (!this.settings.showTemplatePreview) {
            await runGenerate();
            return;
          }

          new TemplatePreviewModal(this.app, rendered, ctx, async (skipPreviewInFuture) => {
            if (skipPreviewInFuture) {
              this.settings.showTemplatePreview = false;
              await this.saveData(this.settings);
            }
            await runGenerate();
          }).open();
        }).open();
      },
    });

    this.addCommand({
      id: "augment-open-settings",
      name: "Open settings",
      callback: () => {
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById("augment-terminal");
      },
    });

    this.addCommand({
      id: "open-welcome",
      name: "Open welcome",
      callback: () => {
        void this.createAndOpenWelcomeNote();
      },
    });

    this.addCommand({
      id: "augment-view-context",
      name: "Open context inspector",
      callback: () => {
        this.openContextInspector();
      },
    });

    this.addSettingTab(new AugmentSettingTab(this.app, this));

    // Status bar — model name, click to open settings
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.style.cursor = "pointer";
    this.statusBarEl.addEventListener("click", () => {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById("augment-terminal");
    });
    this.refreshStatusBar();

    // First-load welcome note — shown once, only when not yet configured
    if (!this.settings.apiKey && !this.settings.hasSeenWelcome) {
      this.settings.hasSeenWelcome = true;
      void this.saveData(this.settings);
      this.app.workspace.onLayoutReady(() => {
        void this.createAndOpenWelcomeNote();
      });
    }

    // Right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        if (!this.settings.apiKey) {
          menu.addItem((item) => {
            item
              .setTitle("Augment: add API key to get started \u2192")
              .setIcon("wand-2")
              .onClick(() => {
                (this.app as any).setting.open();
                (this.app as any).setting.openTabById("augment-terminal");
              });
          });
          return;
        }
        menu.addItem((item) => {
          item
            .setTitle("Augment: Generate")
            .setIcon("wand-2")
            .onClick(() => {
              (this.app as any).commands.executeCommandById("augment-terminal:augment-generate");
            });
        });
        menu.addItem((item) => {
          item
            .setTitle("Augment: Generate from template\u2026")
            .setIcon("wand-2")
            .onClick(() => {
              (this.app as any).commands.executeCommandById("augment-terminal:augment-generate-from-template");
            });
        });
      })
    );

    // Ribbon — generate if configured, otherwise open settings
    this.addRibbonIcon("radio-tower", "Augment: generate AI text in current note", () => {
      if (!this.settings.apiKey) {
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById("augment-terminal");
        return;
      }
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) {
        console.log("[Augment] no active note for generate");
        new Notice("Open a note to generate");
        return;
      }
      this.triggerGenerate(view.editor);
    });

    // Add ribbon icon
    this.addRibbonIcon("terminal", "Open terminal", () => {
      this.openTerminal();
    });

    // Add command
    this.addCommand({
      id: "open-terminal",
      name: "Open terminal",
      callback: () => {
        this.openTerminal();
      },
    });

    // Tiling commands
    this.addCommand({
      id: "open-terminal-right",
      name: "Open terminal to the right",
      callback: () => {
        this.openTerminal("split-vertical");
      },
    });

    this.addCommand({
      id: "open-terminal-down",
      name: "Open terminal below",
      callback: () => {
        this.openTerminal("split-horizontal");
      },
    });

    this.addCommand({
      id: "open-terminal-grid",
      name: "Open terminal grid (2x2)",
      callback: () => {
        this.openTerminalGrid();
      },
    });

    // Sidebar terminal
    this.addCommand({
      id: "open-terminal-sidebar",
      name: "Open terminal in sidebar",
      callback: () => {
        this.openTerminalSidebar();
      },
    });

    // Rename command
    this.addCommand({
      id: "rename-terminal",
      name: "Rename terminal",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(TerminalView);
        if (view) {
          new RenameModal(this.app, view).open();
        }
      },
    });

    // Terminal manager
    this.addCommand({
      id: "open-terminal-manager",
      name: "Show terminal manager",
      callback: () => {
        this.openTerminalManager();
      },
    });

    // Terminal switcher
    this.addCommand({
      id: "switch-terminal",
      name: "Switch terminal",
      callback: () => {
        new TerminalSwitcherModal(this.app).open();
      },
    });

    this.registerEvent(
      (this.app.workspace as any).on("augment-terminal:teamcreate", (event: TeamCreateSpawnEvent) => {
        void this.handleTeamCreateSpawn(event);
      })
    );
  }

  async onunload(): Promise<void> {
    delete (globalThis as any).__augmentCancelGeneration;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL_MANAGER);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CONTEXT_INSPECTOR);
    cleanupXtermStyle();
    this.calloutStyleEl?.remove();
    this.calloutStyleEl = null;
  }

  private getPluginDir(): string {
    return (this.app.vault.adapter as any).basePath + "/.obsidian/plugins/augment-terminal";
  }

  private async createAndOpenWelcomeNote(): Promise<void> {
    const folderPath = "Augment";
    const filePath = "Augment/Get started.md";

    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    if (!this.app.vault.getAbstractFileByPath(filePath)) {
      const mod = process.platform === "darwin" ? "Cmd" : "Ctrl";
      await this.app.vault.create(filePath, buildWelcomeNoteContent(mod));
    }

    const file = this.app.vault.getAbstractFileByPath(filePath) as TFile;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
  }

  private async openTerminal(
    mode: "tab" | "split-vertical" | "split-horizontal" = "tab",
    options?: { name?: string; active?: boolean; reveal?: boolean }
  ): Promise<TerminalView> {
    const { workspace } = this.app;
    const desiredName = options?.name?.trim();
    const active = options?.active ?? true;
    const reveal = options?.reveal ?? true;

    let leaf;
    if (mode === "split-vertical") {
      leaf = workspace.getLeaf("split", "vertical");
    } else if (mode === "split-horizontal") {
      leaf = workspace.getLeaf("split", "horizontal");
    } else {
      leaf = workspace.getLeaf("tab");
    }

    await leaf.setViewState({
      type: VIEW_TYPE_TERMINAL,
      active,
      state: desiredName ? { name: desiredName } : undefined,
    });

    if (desiredName) {
      const view = leaf.view as Partial<TerminalView>;
      if (typeof view.setName === "function") {
        view.setName(desiredName);
      }
    }

    if (reveal) {
      workspace.revealLeaf(leaf);
    }

    return leaf.view as TerminalView;
  }

  private async openTerminalSidebar(): Promise<TerminalView | null> {
    const { workspace } = this.app;
    const leaf = workspace.getRightLeaf(false);

    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL,
        active: true,
      });
      workspace.revealLeaf(leaf);
      return leaf.view as TerminalView;
    }
    return null;
  }

  private async openTerminalManager(): Promise<void> {
    const { workspace } = this.app;

    // Reuse existing manager leaf
    const existing = workspace.getLeavesOfType(VIEW_TYPE_TERMINAL_MANAGER);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL_MANAGER,
        active: true,
      });
      workspace.revealLeaf(leaf);
    }
  }

  private async openTerminalGrid(): Promise<void> {
    const { workspace } = this.app;

    const topLeft = workspace.getLeaf("tab");
    await topLeft.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    const topRight = (workspace as any).createLeafBySplit(topLeft, "vertical");
    await topRight.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    const bottomLeft = (workspace as any).createLeafBySplit(topLeft, "horizontal");
    await bottomLeft.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    const bottomRight = (workspace as any).createLeafBySplit(topRight, "horizontal");
    await bottomRight.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    workspace.revealLeaf(topLeft);
  }

  private async handleTeamCreateSpawn(event: TeamCreateSpawnEvent): Promise<void> {
    const members = Array.from(
      new Set(
        (event.members ?? [])
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      )
    );
    if (members.length === 0) return;

    const signature = `${event.team ?? ""}|${members.slice().sort().join(",")}`;
    const now = Date.now();
    const previous = this.recentTeamCreateSpawnSignatures.get(signature);
    if (previous && now - previous < 15_000) {
      return;
    }
    this.recentTeamCreateSpawnSignatures.set(signature, now);
    if (this.recentTeamCreateSpawnSignatures.size > 150) {
      for (const [key, ts] of this.recentTeamCreateSpawnSignatures) {
        if (now - ts > 60_000) {
          this.recentTeamCreateSpawnSignatures.delete(key);
        }
      }
    }

    for (const member of members) {
      if (this.hasTerminalNamed(member)) continue;
      await this.openTerminal("tab", {
        name: member,
        active: false,
        reveal: false,
      });
    }
  }

  public insertAgentWidget(editor: Editor, pos: { line: number; ch: number }, name: string): void {
    const cmView = (editor as any).cm as EditorView;
    const offset = editor.posToOffset(pos);
    cmView.dispatch({ effects: addAgentWidgetEffect.of({ pos: offset, name }) });
  }

  public async launchSkillSession(file: TFile, skillName: string, editor?: Editor): Promise<void> {
    const vaultBase = (this.app.vault.adapter as any).basePath as string;
    const absolutePath = `${vaultBase}/${file.path}`;

    // Build a claude shell command: claude "/{skillName} on {absoluteFilePath}"
    // Escape double quotes in the path to avoid shell breakage.
    const safePath = absolutePath.replace(/"/g, '\\"');
    const claudeCmd = `claude "/${skillName} on ${safePath}"\n`;

    // Open in right sidebar without stealing focus from the note.
    const terminalView = await this.openTerminalSidebar();
    if (!terminalView) return;

    // Mark as skill session immediately — green steady dot in terminal manager.
    terminalView.markSkillRunning();
    terminalView.setSkillName(skillName);

    // Shell needs ~1500ms to initialize before we can write to it.
    setTimeout(() => {
      terminalView.write(claudeCmd);
    }, 1500);

    // Remove the inline widget silently when the terminal process exits.
    if (editor) {
      const cmView = (editor as any).cm as EditorView;
      const ref = this.app.workspace.on("augment-terminal:changed", () => {
        if (terminalView.getStatus() === "exited") {
          this.app.workspace.offref(ref);
          try {
            cmView.dispatch({ effects: removeAgentWidgetEffect.of(null) });
          } catch {
            // Editor may have been closed before the process exited — ignore.
          }
        }
      });
    }
  }

  private appendSessionRecord(name: string, status: "exited" | "crashed", startedAt: number, skillName?: string): void {
    const record: SessionRecord = {
      id: `${startedAt}-${Math.random().toString(36).slice(2)}`,
      name,
      skillName,
      status,
      startedAt,
      closedAt: Date.now(),
    };
    if (!Array.isArray(this.settings.sessionHistory)) {
      this.settings.sessionHistory = [];
    }
    this.settings.sessionHistory.push(record);
    if (this.settings.sessionHistory.length > 200) {
      this.settings.sessionHistory = this.settings.sessionHistory.slice(-200);
    }
    void this.saveData(this.settings);
  }

  public async openTerminalNamed(name: string): Promise<void> {
    await this.openTerminal("tab", { name });
  }

  public openContextInspector(): void {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      leaf.setViewState({ type: VIEW_TYPE_CONTEXT_INSPECTOR, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  public async openFocusedTerminal(): Promise<TerminalView> {
    return this.openTerminal("tab", { active: true });
  }

  public deleteSessionRecord(id: string): void {
    this.settings.sessionHistory = (this.settings.sessionHistory ?? []).filter(r => r.id !== id);
    void this.saveData(this.settings);
    this.app.workspace.trigger("augment-terminal:changed");
  }

  private hasTerminalNamed(name: string): boolean {
    const target = name.trim().toLowerCase();
    if (!target) return false;

    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    for (const leaf of leaves) {
      const view = leaf.view as Partial<TerminalView>;
      const viewName = typeof view.getName === "function" ? view.getName().trim() : "";
      if (viewName.toLowerCase() === target) {
        return true;
      }

      const leafAny = leaf as any;
      const stateName = leafAny.getViewState?.()?.state?.name;
      if (typeof stateName === "string" && stateName.trim().toLowerCase() === target) {
        return true;
      }
    }

    return false;
  }
}
