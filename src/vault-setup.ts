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

  // Seed an example template that demonstrates linked_notes_array and Liquid loops.
  if (!app.vault.getAbstractFileByPath(templateFolder)) {
    try { await app.vault.createFolder(templateFolder); } catch { /* already exists */ }
  }
  const exampleTemplatePath = `${templateFolder}/Linked notes summary.md`;
  if (!app.vault.getAbstractFileByPath(exampleTemplatePath)) {
    const exampleContent = [
      "---",
      "name: Linked notes summary",
      "description: Summarize this note and its linked notes as structured bullet points",
      "---",
      'Summarize "{{ title }}" and its linked notes as structured bullet points.',
      "",
      "Note content:",
      "{{ note_content | truncate: 2000 }}",
      "",
      "{% if linked_notes_array.size > 0 %}",
      "Linked notes ({{ linked_notes_array | map: \"title\" | join: \", \" }}):",
      "{% for note in linked_notes_array %}",
      "### {{ note.title }}",
      "{{ note.content | truncate: 500 }}",
      "{% endfor %}",
      "{% endif %}",
      "",
      "Provide a concise summary with the main themes and key points across all notes.",
    ].join("\n");
    await app.vault.create(exampleTemplatePath, exampleContent);
  }
}
