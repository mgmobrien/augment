import { App } from "obsidian";

export async function setupVaultForClaude(app: App, templateFolder: string): Promise<void> {
  const claudeMdPath = "CLAUDE.md";
  if (!app.vault.getAbstractFileByPath(claudeMdPath)) {
    const content = `# Vault\n\nThis is my Obsidian vault.\n\n## Agent skills\n\nSkills live in \`agents/skills/\`. Run them with \`/[skill name]\` in any note (requires Augment).\n\n## Templates\n\nPrompt templates live in \`${templateFolder}\`. Run with Cmd+Shift+Enter.\n`;
    await app.vault.create(claudeMdPath, content);
  }

  const skillsPath = "agents/skills";
  if (!app.vault.getAbstractFileByPath(skillsPath)) {
    await app.vault.createFolder(skillsPath);
  }
}
