import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { TeamRosterMember, TeamRosterProject } from "./team-roster";

export interface TeamLaunchSpec {
  project: TeamRosterProject;
  teamId: string;
  specs: MemberLaunchSpec[];
}

export interface MemberLaunchSpec {
  member: TeamRosterMember;
  bootPrompt: string;
  cwd: string;
}

export interface LayoutSlot {
  member: TeamRosterMember;
  column: number;
  row: number;
}

function escapeShellDoubleQuoted(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/\r?\n+/g, " ")
    .trim();
}

function formatLaunchTimestamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}-${milliseconds}`;
}

function formatMemberRole(member: TeamRosterMember): string {
  const displayName = member.displayName.trim();
  if (/part$/i.test(displayName)) {
    return `the ${displayName}`;
  }
  return `the ${displayName} part`;
}

function withTrailingSeparator(filePath: string): string {
  if (/[\\/]$/.test(filePath)) return filePath;
  return `${filePath}${filePath.includes("\\") ? "\\" : "/"}`;
}

function toFsPath(rootPath: string, relativePath: string): string {
  return path.join(rootPath, ...relativePath.split("/").filter(Boolean));
}

function writePromptFileAndBuildCommand(
  promptText: string,
  label: string,
  model?: string | null
): string {
  const tmpDir = os.tmpdir();
  const timestamp = Date.now();
  const filename = `augment-boot-${label}-${timestamp}.txt`;
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, promptText, "utf-8");
  const trimmedModel = model?.trim();
  const modelArg = trimmedModel ? ` --model ${JSON.stringify(trimmedModel)}` : "";
  return `claude${modelArg} "$(cat ${JSON.stringify(filePath)})"\n`;
}

function buildManagedTeamId(project: TeamRosterProject, launchedAt: Date): string {
  const displayName = encodeURIComponent(project.projectDisplayName.trim() || project.projectId);
  return `${project.projectId}::${displayName}::${formatLaunchTimestamp(launchedAt)}`;
}

function orderedProjectMembers(project: TeamRosterProject): TeamRosterMember[] {
  return [
    project.ceo,
    ...project.members.filter((member) => member.roleId !== project.ceo.roleId),
  ];
}

function formatRosterDirectory(member: TeamRosterMember): string {
  const trimmed = member.directory.trim().replace(/`/g, "").replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : `${member.roleId}/`;
}

function formatRosterEntry(member: TeamRosterMember): string {
  const scope = [member.owns.trim(), member.perspective.trim()]
    .filter((part) => part.length > 0)
    .join(", ");
  const details = scope || "Role scope not specified";
  return `- ${member.displayName} (${formatRosterDirectory(member)}, role: ${member.roleId}, address: ${member.address}) - ${details}`;
}

function buildBusInstructions(
  project: TeamRosterProject,
  member: TeamRosterMember,
  vaultRoot: string
): string {
  const slug = project.projectId;
  const address = `${member.roleId}@${slug}`;
  const hooksDir = path.join(vaultRoot, "claude", "hooks");
  const rosterAddresses = project.members
    .map((m) => `${m.roleId}@${slug}`)
    .join(", ");
  return [
    `=== Inter-role communication ===`,
    `Your bus address is: ${address}.`,
    `To send a message: bash ${hooksDir}/inbox-send.sh --to {role}@${slug} --from ${address} --subject "subject" --body "message body".`,
    `To check your inbox: bash ${hooksDir}/inbox-check.sh --address ${address} --format claude --mark read.`,
    `Team roster addresses: ${rosterAddresses}.`,
    `When you need input from another role, message them directly via the bus.`,
  ].join(" ");
}

export function buildBusWatcherCommand(address: string, paneId: string, vaultRoot: string): string {
  const watcherPath = path.join(
    vaultRoot,
    "agents",
    "skills",
    "codex-subagent",
    "scripts",
    "cc-bus-watcher.sh"
  );
  return `bash ${JSON.stringify(watcherPath)} ${JSON.stringify(address)} "${paneId}" &`;
}

export function buildPostLaunchWatcherSetup(
  project: TeamRosterProject,
  vaultRoot: string
): { address: string; roleId: string }[] {
  void vaultRoot;

  return orderedProjectMembers(project).map((member) => ({
    address: member.address || `${member.roleId}@${project.projectId}`,
    roleId: member.roleId,
  }));
}

export function buildCeoBootPrompt(
  project: TeamRosterProject,
  codeRoot: string,
  vaultRoot: string,
  userBrief?: string
): string {
  const codeRootPath = withTrailingSeparator(codeRoot);
  const vaultWorkspacePath = withTrailingSeparator(toFsPath(vaultRoot, project.workspacePath));
  const partsMdPath = toFsPath(vaultRoot, project.partsMdPath);
  const skillPath = path.join(vaultRoot, "agents", "skills", "project-ceo", "SKILL.md");
  const brief = userBrief?.trim();
  const busInstructions = buildBusInstructions(project, project.ceo, vaultRoot);
  const message = [
    `You are the CEO for the ${project.projectDisplayName} project.`,
    `This is the same role Matt invokes as "${project.projectDisplayName} CEO".`,
    `Boot as ${project.ceo.address}.`,
    `Project root: ${codeRootPath}.`,
    `Vault workspace: ${vaultWorkspacePath}.`,
    `Read the project constitution at ${partsMdPath}.`,
    `Follow the generic CEO skill at ${skillPath}.`,
    "The full roster is already launched in Augment-managed terminals; coordinate with the existing teammates via the vault bus and do not spawn duplicate teammates.",
    busInstructions,
    brief ? `User brief: ${brief}.` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");

  return writePromptFileAndBuildCommand(
    message,
    `ceo-${project.projectId}`,
    project.managedLaunchModel
  );
}

export function buildCeoOnlyBootPrompt(
  project: TeamRosterProject,
  codeRoot: string,
  vaultRoot: string,
  userBrief?: string
): string {
  const codeRootPath = withTrailingSeparator(codeRoot);
  const vaultWorkspacePath = withTrailingSeparator(toFsPath(vaultRoot, project.workspacePath));
  const partsMdPath = toFsPath(vaultRoot, project.partsMdPath);
  const skillPath = path.join(vaultRoot, "agents", "skills", "project-ceo", "SKILL.md");
  const brief = userBrief?.trim();
  const roster = orderedProjectMembers(project).map(formatRosterEntry).join("\n");
  const message = [
    `You are the CEO for the ${project.projectDisplayName} project.`,
    `Project identity: ${project.projectId} (${project.projectDisplayName}).`,
    `Boot as ${project.ceo.address}.`,
    `Project root path: ${codeRootPath}.`,
    `Vault workspace path: ${vaultWorkspacePath}.`,
    `PARTS.md path: ${partsMdPath}.`,
    `CEO skill path: ${skillPath}.`,
    "You are launching via Augment's CC team mode. Create a Claude Code team using TeamCreate, then spawn each roster member using the Agent tool. CC will handle messaging and wake-on-idle natively. Do NOT use the vault bus for inter-member communication - use CC's SendMessage.",
    "You already occupy the CEO seat in the current terminal. Use TeamCreate first, then spawn every remaining roster member with Agent using the same team_name so they all join the same Claude Code team.",
    "Do NOT create terminals manually or ask Augment to create panes. Let Claude Code's Agent tool handle pane creation.",
    "Read PARTS.md and the CEO skill before delegating.",
    "When teammates need to coordinate, use Claude Code's native SendMessage tool rather than any filesystem mailbox or vault bus.",
    project.ccLaunchModel
      ? `Model override for this project: use ${project.ccLaunchModel} for every spawned teammate unless Matt explicitly says otherwise. This team exists for cheap launch-path testing, not for deep project work.`
      : null,
    "Roster to spawn:",
    roster,
    brief ? `User brief: ${brief}.` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");

  return writePromptFileAndBuildCommand(
    message,
    `cc-ceo-${project.projectId}`,
    project.ccLaunchModel
  );
}

export function buildMemberBootPrompt(
  project: TeamRosterProject,
  member: TeamRosterMember,
  codeRoot: string,
  vaultRoot: string
): string {
  const codeRootPath = withTrailingSeparator(codeRoot);
  const vaultWorkspacePath = withTrailingSeparator(toFsPath(vaultRoot, project.workspacePath));
  const memberWorkspacePath = withTrailingSeparator(toFsPath(vaultRoot, member.workspacePath));
  const partsMdPath = toFsPath(vaultRoot, project.partsMdPath);
  const skillPath = path.join(vaultRoot, "agents", "skills", `project-${member.roleId}`, "SKILL.md");
  const busInstructions = buildBusInstructions(project, member, vaultRoot);
  const message = [
    `You are ${formatMemberRole(member)} for the ${project.projectDisplayName} project.`,
    `Boot as ${member.address}.`,
    `Project root: ${codeRootPath}.`,
    `Vault workspace: ${vaultWorkspacePath}.`,
    `Read the project constitution at ${partsMdPath}.`,
    `Follow the generic role skill at ${skillPath}.`,
    `Read your workspace at ${memberWorkspacePath}.`,
    "The team is already launched in Augment-managed mode; coordinate with the CEO via the vault bus, do not spawn duplicate teammates.",
    busInstructions,
  ].join("\n");

  return writePromptFileAndBuildCommand(
    message,
    `${member.roleId}-${project.projectId}`,
    project.managedLaunchModel
  );
}

export function buildTeamLaunchSpec(
  project: TeamRosterProject,
  codeRoot: string,
  vaultRoot: string,
  userBrief?: string
): TeamLaunchSpec {
  const launchedAt = new Date();
  const cwd = codeRoot.trim();
  const specs = orderedProjectMembers(project).map((member) => ({
    member,
    bootPrompt: member.roleId === project.ceo.roleId
      ? buildCeoBootPrompt(project, cwd, vaultRoot, userBrief)
      : buildMemberBootPrompt(project, member, cwd, vaultRoot),
    cwd,
  }));

  return {
    project,
    teamId: buildManagedTeamId(project, launchedAt),
    specs,
  };
}

export function computeTeamLayout(members: TeamRosterMember[]): LayoutSlot[] {
  if (members.length === 0) return [];

  const ceo = members.find((member) => member.isLead) ?? members[0];
  const others = members.filter((member) => member.roleId !== ceo.roleId);
  const middleCount = Math.ceil(others.length / 2);

  const slots: LayoutSlot[] = [
    { member: ceo, column: 0, row: 0 },
  ];

  others.slice(0, middleCount).forEach((member, index) => {
    slots.push({ member, column: 1, row: index });
  });

  others.slice(middleCount).forEach((member, index) => {
    slots.push({ member, column: 2, row: index });
  });

  return slots;
}
