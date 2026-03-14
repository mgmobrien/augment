import { App, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile, TFolder } from "obsidian";

export type SlashSuggestion =
  | { kind: "header"; label: string }
  | { kind: "skill"; name: string; description: string; file: TFile }
  | { kind: "command"; id: string; name: string };

// Folders to scan for skills, in priority order.
// For each root, prefer root/skills/ subfolder; fall back to root/ itself.
const SKILL_SCAN_ROOTS = ["agents", ".agents", ".claude", ".augment"];

function displayCommandName(id: string, name: string): string {
  if (id.startsWith("augment-terminal:") && name.startsWith("Augment: ")) {
    return name.replace(/^Augment:\s+/, "");
  }
  return name;
}

export class AgentSuggest extends EditorSuggest<SlashSuggestion> {
  private skills: Array<{ name: string; description: string; file: TFile }> = [];

  constructor(app: App) {
    super(app);
    this.loadSkills();
  }

  private loadSkills(): void {
    const seen = new Set<string>();
    const entries: Array<{ name: string; description: string; file: TFile }> = [];

    for (const root of SKILL_SCAN_ROOTS) {
      // Prefer root/skills/ subfolder; fall back to root/ itself.
      const subfolder = this.app.vault.getAbstractFileByPath(`${root}/skills`);
      const scanFolder = subfolder instanceof TFolder
        ? subfolder
        : this.app.vault.getAbstractFileByPath(root);
      if (!(scanFolder instanceof TFolder)) continue;

      for (const child of scanFolder.children) {
        if (!(child instanceof TFolder)) continue;
        const skillFile = this.app.vault.getAbstractFileByPath(`${scanFolder.path}/${child.name}/SKILL.md`);
        if (!(skillFile instanceof TFile)) continue;
        const fm = this.app.metadataCache.getFileCache(skillFile)?.frontmatter;
        if (!fm) continue;
        if (fm.user_invocable === false) continue;
        const name = typeof fm.name === "string" ? fm.name : child.name;
        if (seen.has(name)) continue; // dedup across symlinked roots
        seen.add(name);
        entries.push({
          name,
          description: typeof fm.description === "string" ? fm.description : "",
          file: skillFile,
        });
      }
    }

    this.skills = entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  public reload(): void {
    this.loadSkills();
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    // Require / to be at line start or preceded by whitespace — avoids
    // triggering inside URLs (http://...) or wikilink paths ([[foo/bar]]).
    const match = before.match(/(^|[\s])\/(\S*)$/);
    if (!match) return null;
    const slashPos = before.lastIndexOf("/");
    return {
      start: { line: cursor.line, ch: slashPos },
      end: cursor,
      query: match[2],
    };
  }

  getSuggestions(ctx: EditorSuggestContext): SlashSuggestion[] {
    const q = ctx.query.toLowerCase();

    const matchedSkills = q
      ? this.skills.filter(s => s.name.includes(q) || s.description.toLowerCase().includes(q))
      : this.skills;

    const allCommands = Object.values(
      (this.app as any).commands.commands as Record<string, { id: string; name: string }>
    );
    const matchedCommands = allCommands.filter(c => c.name.toLowerCase().includes(q));

    const result: SlashSuggestion[] = [];

    if (matchedSkills.length > 0) {
      result.push({ kind: "header", label: "Skills" });
      for (const s of matchedSkills) {
        result.push({ kind: "skill", name: s.name, description: s.description, file: s.file });
      }
    }

    if (matchedCommands.length > 0) {
      result.push({ kind: "header", label: "Commands" });
      for (const c of matchedCommands) {
        result.push({
          kind: "command",
          id: c.id,
          name: displayCommandName(c.id, c.name),
        });
      }
    }

    return result;
  }

  renderSuggestion(item: SlashSuggestion, el: HTMLElement): void {
    if (item.kind === "header") {
      el.createEl("div", { cls: "augment-slash-section-header", text: item.label });
      return;
    }
    if (item.kind === "skill") {
      el.createEl("div", { cls: "augment-skill-name", text: item.name });
      if (item.description) {
        el.createEl("div", { cls: "augment-skill-desc", text: item.description });
      }
    } else {
      el.createEl("div", { text: item.name });
    }
  }

  selectSuggestion(item: SlashSuggestion): void {
    if (item.kind === "header") return; // non-selectable

    const editor = this.context?.editor;
    const file = this.context?.file;
    if (!editor) return;

    // Delete the full /[query] from the editor.
    editor.replaceRange("", this.context!.start, this.context!.end);

    if (item.kind === "skill") {
      if (!file) return;
      const plugin = (this.app as any).plugins?.plugins?.["augment-terminal"];
      if (plugin) {
        plugin.insertAgentWidget(editor, this.context!.start, item.name);
        void plugin.launchSkillSession(file, item.name, editor);
      }
    } else if (item.kind === "command") {
      (this.app as any).commands.executeCommandById(item.id);
    }
  }
}
