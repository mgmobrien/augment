import * as fs from "fs";
import * as path from "path";

export interface TeamRosterMember {
  roleId: string;
  displayName: string;
  directory: string;
  owns: string;
  perspective: string;
  address: string;
  workspacePath: string;
  isLead: boolean;
}

export interface TeamRosterProject {
  projectId: string;
  projectDisplayName: string;
  partsMdPath: string;
  workspacePath: string;
  codeRoot: string | null;
  managedLaunchModel: string | null;
  ccLaunchModel: string | null;
  members: TeamRosterMember[];
  ceo: TeamRosterMember;
}

const PARTS_ROOT = ["agents", "parts"] as const;
const REQUIRED_HEADERS = ["part", "directory", "owns", "perspective"] as const;

type HeaderKey = typeof REQUIRED_HEADERS[number];

interface TeamLaunchConfig {
  managedLaunchModel: string | null;
  ccLaunchModel: string | null;
}

function toVaultPath(...segments: string[]): string {
  return segments.join("/");
}

function findProjectDisplayName(lines: string[]): string | null {
  for (const line of lines) {
    const match = line.match(/^\s*#(?!#)\s+(.+?)(?:\s+#+\s*)?\s*$/);
    if (match) {
      const name = match[1]?.trim();
      if (name) return name;
    }
  }

  return null;
}

function findCodeRoot(lines: string[]): string | null {
  const idx = lines.findIndex((line) =>
    /^\s*##(?!#)\s+Code\s+root(?:\s+#+\s*)?\s*$/i.test(line)
  );
  if (idx === -1) return null;

  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\s{0,3}#{1,2}(?!#)\s+/.test(lines[i])) break;
    const trimmed = lines[i].trim().replace(/^`+|`+$/g, "");
    if (trimmed) return trimmed;
  }

  return null;
}

function findRosterSection(lines: string[]): string[] | null {
  const rosterIndex = lines.findIndex((line) =>
    /^\s*##(?!#)\s+Roster(?:\s+#+\s*)?\s*$/.test(line)
  );
  if (rosterIndex === -1) return null;

  const section: string[] = [];
  for (let i = rosterIndex + 1; i < lines.length; i++) {
    if (/^\s{0,3}#{1,2}(?!#)\s+/.test(lines[i])) break;
    section.push(lines[i]);
  }

  return section;
}

function looksLikeTableRow(line: string): boolean {
  return /^\s*\|/.test(line) || /^\s*[^|].*\|.*\|?\s*$/.test(line);
}

function splitMarkdownTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function isSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(isSeparatorCell);
}

function normalizeHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeRoleId(directory: string): string {
  return directory.replace(/`/g, "").trim().replace(/\/+$/, "").trim();
}

function normalizeLaunchModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

async function readLaunchConfig(projectDir: string): Promise<TeamLaunchConfig> {
  const configPath = path.join(projectDir, "launch-config.json");

  try {
    const raw = await fs.promises.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      managedLaunchModel?: unknown;
      ccLaunchModel?: unknown;
      launchModel?: unknown;
    };

    const fallback = normalizeLaunchModel(parsed.launchModel);
    return {
      managedLaunchModel: normalizeLaunchModel(parsed.managedLaunchModel) ?? fallback,
      ccLaunchModel: normalizeLaunchModel(parsed.ccLaunchModel) ?? fallback,
    };
  } catch {
    return {
      managedLaunchModel: null,
      ccLaunchModel: null,
    };
  }
}

function parseRosterTable(sectionLines: string[], projectId: string): TeamRosterMember[] | null {
  let tableStart = -1;
  let headerCells: string[] | null = null;

  for (let i = 0; i < sectionLines.length - 1; i++) {
    if (!looksLikeTableRow(sectionLines[i]) || !looksLikeTableRow(sectionLines[i + 1])) {
      continue;
    }

    const maybeHeader = splitMarkdownTableRow(sectionLines[i]);
    const maybeSeparator = splitMarkdownTableRow(sectionLines[i + 1]);
    if (!isSeparatorRow(maybeSeparator)) continue;

    tableStart = i;
    headerCells = maybeHeader;
    break;
  }

  if (tableStart === -1 || headerCells === null) return null;

  const headerIndexes = new Map<HeaderKey, number>();
  headerCells.forEach((cell, index) => {
    const normalized = normalizeHeader(cell);
    if ((REQUIRED_HEADERS as readonly string[]).includes(normalized)) {
      headerIndexes.set(normalized as HeaderKey, index);
    }
  });

  if (headerIndexes.size !== REQUIRED_HEADERS.length) return null;

  const members: TeamRosterMember[] = [];
  const seenRoleIds = new Set<string>();

  for (let i = tableStart + 2; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    if (!looksLikeTableRow(line)) break;

    const cells = splitMarkdownTableRow(line);
    if (cells.every((cell) => !cell.trim())) continue;

    const displayName = cells[headerIndexes.get("part")!] ?? "";
    const directory = cells[headerIndexes.get("directory")!] ?? "";
    const owns = cells[headerIndexes.get("owns")!] ?? "";
    const perspective = cells[headerIndexes.get("perspective")!] ?? "";
    const roleId = normalizeRoleId(directory);

    if (!displayName.trim() || !directory.trim() || !roleId) return null;
    if (seenRoleIds.has(roleId)) return null;

    seenRoleIds.add(roleId);
    members.push({
      roleId,
      displayName: displayName.trim(),
      directory: directory.trim(),
      owns: owns.trim(),
      perspective: perspective.trim(),
      address: `${roleId}@${projectId}`,
      workspacePath: toVaultPath(...PARTS_ROOT, projectId, roleId),
      isLead: roleId === "ceo",
    });
  }

  return members.length > 0 ? members : null;
}

export function parsePartsMd(content: string, projectId: string): TeamRosterProject | null {
  const lines = content.split(/\r?\n/);
  const projectDisplayName = findProjectDisplayName(lines);
  if (!projectDisplayName) return null;

  const rosterSection = findRosterSection(lines);
  if (!rosterSection) return null;

  const members = parseRosterTable(rosterSection, projectId);
  if (!members) return null;

  const ceos = members.filter((member) => member.isLead);
  if (ceos.length !== 1) return null;

  return {
    projectId,
    projectDisplayName,
    partsMdPath: toVaultPath(...PARTS_ROOT, projectId, "PARTS.md"),
    workspacePath: toVaultPath(...PARTS_ROOT, projectId),
    codeRoot: findCodeRoot(lines),
    managedLaunchModel: null,
    ccLaunchModel: null,
    members,
    ceo: ceos[0],
  };
}

export async function discoverTeamProjects(vaultPath: string): Promise<TeamRosterProject[]> {
  const projectsRoot = path.join(vaultPath, ...PARTS_ROOT);

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const projectDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const projects = await Promise.all(
    projectDirs.map(async (projectId) => {
      const projectDir = path.join(projectsRoot, projectId);
      const partsMdFsPath = path.join(projectDir, "PARTS.md");

      try {
        const stat = await fs.promises.stat(partsMdFsPath);
        if (!stat.isFile()) return null;
      } catch {
        return null;
      }

      try {
        const content = await fs.promises.readFile(partsMdFsPath, "utf-8");
        const project = parsePartsMd(content, projectId);
        if (!project) return null;

        const launchConfig = await readLaunchConfig(projectDir);
        return {
          ...project,
          ...launchConfig,
        };
      } catch {
        return null;
      }
    })
  );

  return projects.filter((project): project is TeamRosterProject => project !== null);
}
