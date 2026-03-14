import * as fs from "fs";
import * as path from "path";
import { parseLaunchConfig, parsePartsMd } from "../packages/shared-domain/src";
import type { TeamRosterLaunchConfig, TeamRosterProject } from "../packages/shared-domain/src";

export type {
  TeamRosterLaunchConfig,
  TeamRosterMember,
  TeamRosterProject,
} from "../packages/shared-domain/src";

const PARTS_ROOT = ["agents", "parts"] as const;

async function readLaunchConfig(projectDir: string): Promise<TeamRosterLaunchConfig> {
  const configPath = path.join(projectDir, "launch-config.json");

  try {
    const raw = await fs.promises.readFile(configPath, "utf-8");
    return parseLaunchConfig(raw);
  } catch {
    return {
      managedLaunchModel: null,
      ccLaunchModel: null,
    };
  }
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
