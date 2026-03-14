import { App, TFile, TFolder, normalizePath } from "obsidian";

const PARTS_ROOT = "agents/parts";

export interface PartInfo {
  name: string;
  address: string;
  habitat: string;
  workspacePath: string;
  isProjectPart: boolean;
}

function hasVisiblePartWorkspace(app: App, workspacePath: string): boolean {
  // Obsidian's indexed vault tree does not reliably expose dot-directories like `.state/`.
  // Discover parts from visible workspace markers instead so live UI discovery matches disk.
  return (
    app.vault.getAbstractFileByPath(normalizePath(`${workspacePath}/sessions`)) instanceof TFolder ||
    app.vault.getAbstractFileByPath(normalizePath(`${workspacePath}/inbox`)) instanceof TFolder ||
    app.vault.getAbstractFileByPath(normalizePath(`${workspacePath}/config.md`)) instanceof TFile
  );
}

export function discoverVaultParts(app: App): PartInfo[] {
  const partsFolder = app.vault.getAbstractFileByPath(PARTS_ROOT);
  if (!(partsFolder instanceof TFolder)) return [];

  const parts: PartInfo[] = [];

  for (const child of partsFolder.children) {
    if (!(child instanceof TFolder)) continue;

    if (hasVisiblePartWorkspace(app, child.path)) {
      parts.push({
        name: child.name,
        address: `${child.name}@vault`,
        habitat: "vault",
        workspacePath: child.path,
        isProjectPart: false,
      });
      continue;
    }

    const projectParts = child.children
      .filter((grandchild): grandchild is TFolder => grandchild instanceof TFolder)
      .filter((grandchild) => hasVisiblePartWorkspace(app, grandchild.path))
      .map((grandchild) => ({
        name: grandchild.name,
        address: `${grandchild.name}@${child.name}`,
        habitat: child.name,
        workspacePath: grandchild.path,
        isProjectPart: true,
      }));

    parts.push(...projectParts);
  }

  return parts.sort((a, b) => {
    if (a.habitat === b.habitat) return a.name.localeCompare(b.name);
    if (a.habitat === "vault") return -1;
    if (b.habitat === "vault") return 1;
    return a.habitat.localeCompare(b.habitat);
  });
}
