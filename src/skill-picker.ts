import { App, FuzzySuggestModal, TFile, TFolder } from "obsidian";

export interface SkillMeta {
  name: string;
  description: string;
  noteTypes: string[];
}

const SKILLS_FOLDER = "agents/skills";

export function scanSkillsForType(app: App, noteType: string): SkillMeta[] {
  const folder = app.vault.getAbstractFileByPath(SKILLS_FOLDER);
  if (!folder || !(folder instanceof TFolder)) return [];

  const results: SkillMeta[] = [];

  for (const child of folder.children) {
    if (!(child instanceof TFolder)) continue;

    const skillFile = app.vault.getAbstractFileByPath(`${child.path}/SKILL.md`);
    if (!skillFile || !(skillFile instanceof TFile)) continue;

    const fm = app.metadataCache.getFileCache(skillFile)?.frontmatter;
    if (!fm?.name || !fm?.note_types) continue;

    const noteTypes: string[] = Array.isArray(fm.note_types)
      ? fm.note_types.map(String)
      : [String(fm.note_types)];

    if (!noteTypes.includes(noteType)) continue;

    results.push({
      name: String(fm.name),
      description: String(fm.description ?? ""),
      noteTypes,
    });
  }

  return results;
}

export class SkillPickerModal extends FuzzySuggestModal<SkillMeta> {
  constructor(
    app: App,
    private skills: SkillMeta[],
    private onChoose: (skill: SkillMeta) => void
  ) {
    super(app);
    this.setPlaceholder("Select a skill to run on this note…");
  }

  getItems(): SkillMeta[] {
    return this.skills;
  }

  getItemText(skill: SkillMeta): string {
    return skill.description ? `${skill.name} — ${skill.description}` : skill.name;
  }

  onChooseItem(skill: SkillMeta): void {
    this.onChoose(skill);
  }
}
