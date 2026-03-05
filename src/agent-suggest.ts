import { App, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile, TFolder } from "obsidian";

export interface SkillEntry {
  name: string;
  description: string;
  file: TFile;
}

export class AgentSuggest extends EditorSuggest<SkillEntry> {
  private skills: SkillEntry[] = [];

  constructor(app: App) {
    super(app);
    this.loadSkills();
  }

  private loadSkills(): void {
    const folder = this.app.vault.getAbstractFileByPath("agents/skills");
    if (!(folder instanceof TFolder)) return;

    const entries: SkillEntry[] = [];
    for (const child of folder.children) {
      if (!(child instanceof TFolder)) continue;
      const skillFile = this.app.vault.getAbstractFileByPath(`agents/skills/${child.name}/SKILL.md`);
      if (!(skillFile instanceof TFile)) continue;
      const cache = this.app.metadataCache.getFileCache(skillFile)?.frontmatter;
      if (!cache) continue;
      if (cache.user_invocable === false) continue;
      entries.push({
        name: cache.name ?? child.name,
        description: typeof cache.description === "string" ? cache.description : "",
        file: skillFile,
      });
    }
    this.skills = entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Reload skills on demand — call after vault changes if needed.
  public reload(): void {
    this.loadSkills();
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const match = before.match(/\/agent\s+(\S*)$/);
    if (!match) return null;
    const queryLen = match[1].length;
    const prefixLen = "/agent ".length;
    return {
      start: { line: cursor.line, ch: before.length - queryLen - prefixLen },
      end: cursor,
      query: match[1],
    };
  }

  getSuggestions(ctx: EditorSuggestContext): SkillEntry[] {
    const q = ctx.query.toLowerCase();
    if (!q) return this.skills;
    return this.skills.filter(
      (s) => s.name.includes(q) || s.description.toLowerCase().includes(q)
    );
  }

  renderSuggestion(skill: SkillEntry, el: HTMLElement): void {
    el.createEl("div", { cls: "augment-skill-name", text: skill.name });
    if (skill.description) {
      el.createEl("div", { cls: "augment-skill-desc", text: skill.description });
    }
  }

  selectSuggestion(skill: SkillEntry): void {
    const editor = this.context?.editor;
    const file = this.context?.file;
    if (!editor || !file) return;

    // Delete the full `/agent [query]` text from the editor.
    const { start, end } = this.context!;
    editor.replaceRange("", start, end);

    // Insert persistent inline status widget at the cleared position.
    const plugin = (this.app as any).plugins?.plugins?.["augment-terminal"];
    if (plugin) {
      plugin.insertAgentWidget(editor, start, skill.name);
      void plugin.launchSkillSession(file, skill.name);
    }
  }
}
