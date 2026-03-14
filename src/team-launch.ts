import * as fs from "fs";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import {
  buildCCAgentId,
  buildCCNativeTeamName,
  buildCCTeamConfigContract,
  buildManagedTeamId,
  computeTeamLayout as computeSharedTeamLayout,
  orderedProjectMembers,
  resolveCCColor,
} from "../packages/shared-domain/src";
import type {
  CCNativeTeamLaunchSpec as SharedCCNativeTeamLaunchSpec,
  CCTeamConfig as SharedCCTeamConfig,
  CCTeamConfigMember as SharedCCTeamConfigMember,
  LayoutSlot as SharedLayoutSlot,
  MemberLaunchSpec as SharedMemberLaunchSpec,
  TeamRosterMember,
  TeamRosterProject,
  TeamLaunchSpec as SharedTeamLaunchSpec,
} from "../packages/shared-domain/src";

export type TeamLaunchSpec = SharedTeamLaunchSpec<TeamRosterMember, TeamRosterProject>;
export type MemberLaunchSpec = SharedMemberLaunchSpec<TeamRosterMember>;
export type LayoutSlot = SharedLayoutSlot<TeamRosterMember>;
export type CCTeamConfigMember = SharedCCTeamConfigMember;
export type CCTeamConfig = SharedCCTeamConfig;
export type CCNativeTeamLaunchSpec = SharedCCNativeTeamLaunchSpec<TeamRosterMember>;

function escapeShellDoubleQuoted(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/\r?\n+/g, " ")
    .trim();
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

function sanitizeFilenameFragment(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  return sanitized || "prompt";
}

function writeRawPromptTempFile(promptText: string, label: string): string {
  const filename = `augment-cc-boot-${sanitizeFilenameFragment(label)}-${Date.now()}-${crypto.randomUUID()}.txt`;
  const filePath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(filePath, promptText, "utf-8");
  return filePath;
}

function extractPromptTextFromWrappedCommand(command: string): string {
  const match = command.match(/\$\(\s*cat\s+("(?:[^"\\]|\\.)*")\s*\)/m);
  if (!match) {
    throw new Error("Unable to extract prompt file path from Claude launch command.");
  }

  const promptFilePath = JSON.parse(match[1]) as string;
  const promptText = fs.readFileSync(promptFilePath, "utf-8");

  try {
    fs.unlinkSync(promptFilePath);
  } catch {
    // Temp prompt cleanup is best-effort.
  }

  return promptText;
}

function resolveCCTeamCwd(project: TeamRosterProject): string {
  const trimmedCodeRoot = project.codeRoot?.trim();
  return trimmedCodeRoot || process.cwd();
}

function buildCCNativeCeoPrompt(
  project: TeamRosterProject,
  codeRoot: string,
  vaultRoot: string,
  teamName: string,
  userBrief?: string
): string {
  const codeRootPath = withTrailingSeparator(codeRoot);
  const vaultWorkspacePath = withTrailingSeparator(toFsPath(vaultRoot, project.workspacePath));
  const partsMdPath = toFsPath(vaultRoot, project.partsMdPath);
  const skillPath = path.join(vaultRoot, "agents", "skills", "project-ceo", "SKILL.md");
  const brief = userBrief?.trim();
  const roster = orderedProjectMembers(project).map(formatRosterEntry).join("\n");
  return [
    `You are the CEO for the ${project.projectDisplayName} project.`,
    `Project identity: ${project.projectId} (${project.projectDisplayName}).`,
    `Boot as ${project.ceo.address}.`,
    `Project root path: ${codeRootPath}.`,
    `Vault workspace path: ${vaultWorkspacePath}.`,
    `PARTS.md path: ${partsMdPath}.`,
    `CEO skill path: ${skillPath}.`,
    `You are in a Claude Code native team named "${teamName}". The team is already scaffolded — config.json and inboxes are pre-created. Do NOT call TeamCreate. Do NOT use the vault bus (inbox-send.sh/inbox-check.sh). Use Claude Code's native SendMessage tool to communicate with teammates.`,
    `All roster members are launched in separate terminals and are part of this CC team. They can receive messages via SendMessage immediately.`,
    `Read PARTS.md and the CEO skill before delegating.`,
    "Roster:",
    roster,
    brief ? `User brief: ${brief}.` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

function buildCCNativeMemberPrompt(
  project: TeamRosterProject,
  member: TeamRosterMember,
  codeRoot: string,
  vaultRoot: string,
  teamName: string
): string {
  const codeRootPath = withTrailingSeparator(codeRoot);
  const vaultWorkspacePath = withTrailingSeparator(toFsPath(vaultRoot, project.workspacePath));
  const memberWorkspacePath = withTrailingSeparator(toFsPath(vaultRoot, member.workspacePath));
  const partsMdPath = toFsPath(vaultRoot, project.partsMdPath);
  const skillPath = path.join(vaultRoot, "agents", "skills", `project-${member.roleId}`, "SKILL.md");
  return [
    `You are ${formatMemberRole(member)} for the ${project.projectDisplayName} project.`,
    `Boot as ${member.address}.`,
    `Project root: ${codeRootPath}.`,
    `Vault workspace: ${vaultWorkspacePath}.`,
    `Read the project constitution at ${partsMdPath}.`,
    `Follow the generic role skill at ${skillPath}.`,
    `Read your workspace at ${memberWorkspacePath}.`,
    `You are part of a Claude Code native team named "${teamName}". Use SendMessage to communicate with teammates. Do NOT use the vault bus (inbox-send.sh/inbox-check.sh). The team roster and inboxes are pre-configured.`,
  ].join("\n");
}

function resolveCCBootPromptText(
  project: TeamRosterProject,
  member: TeamRosterMember,
  codeRoot: string,
  vaultRoot: string,
  teamName: string,
  userBrief?: string
): string {
  if (member.roleId === project.ceo.roleId) {
    return buildCCNativeCeoPrompt(project, codeRoot, vaultRoot, teamName, userBrief);
  }
  return buildCCNativeMemberPrompt(project, member, codeRoot, vaultRoot, teamName);
}

function buildCCTeammateCommandFromPrompt(
  member: TeamRosterMember,
  project: TeamRosterProject,
  teamName: string,
  leaderSessionId: string,
  codeRoot: string,
  promptText: string
): string {
  const promptFilePath = writeRawPromptTempFile(promptText, `${member.roleId}-${teamName}`);
  const agentId = buildCCAgentId(member, teamName);
  const color = resolveCCColor(project, member);
  return `cd ${JSON.stringify(codeRoot)} && CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --agent-id ${JSON.stringify(agentId)} --agent-name ${JSON.stringify(member.roleId)} --team-name ${JSON.stringify(teamName)} --agent-color ${JSON.stringify(color)} --parent-session-id ${JSON.stringify(leaderSessionId)} --teammate-mode tmux "$(cat ${JSON.stringify(promptFilePath)})"`;
}

function getCCTeamDirectory(teamName: string): string {
  return path.join(os.homedir(), ".claude", "teams", teamName);
}

function getCCInboxDirectory(teamName: string): string {
  return path.join(getCCTeamDirectory(teamName), "inboxes");
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

export function generateSessionId(): string {
  return crypto.randomUUID();
}

export function buildCCTeamConfig(
  project: TeamRosterProject,
  teamName: string,
  leaderSessionId: string
): CCTeamConfig {
  const cwd = resolveCCTeamCwd(project);
  const joinedAt = Date.now();

  return buildCCTeamConfigContract(project, teamName, leaderSessionId, {
    cwd,
    joinedAt,
  });
}

export function writeCCTeamScaffolding(teamName: string, config: CCTeamConfig): void {
  const teamDirectory = getCCTeamDirectory(teamName);
  const inboxDirectory = getCCInboxDirectory(teamName);
  const configPath = path.join(teamDirectory, "config.json");

  fs.mkdirSync(inboxDirectory, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  for (const member of config.members) {
    const inboxPath = path.join(inboxDirectory, `${member.name}.json`);
    if (!fs.existsSync(inboxPath)) {
      fs.writeFileSync(inboxPath, "[]\n", "utf-8");
    }
  }
}

export function seedCCInboxMessage(
  teamName: string,
  agentName: string,
  fromName: string,
  text: string
): void {
  const inboxDirectory = getCCInboxDirectory(teamName);
  const inboxPath = path.join(inboxDirectory, `${agentName}.json`);
  const messages = [
    {
      from: fromName,
      text,
      summary: "Initial boot prompt",
      timestamp: new Date().toISOString(),
      read: false,
    },
  ];

  fs.mkdirSync(inboxDirectory, { recursive: true });
  fs.writeFileSync(inboxPath, `${JSON.stringify(messages, null, 2)}\n`, "utf-8");
}

export function buildCCTeammateCommand(
  member: TeamRosterMember,
  project: TeamRosterProject,
  teamName: string,
  leaderSessionId: string,
  codeRoot: string,
  vaultRoot: string
): string {
  const resolvedCodeRoot = codeRoot.trim() || resolveCCTeamCwd(project);
  const resolvedVaultRoot = vaultRoot.trim() || process.cwd();
  const promptText = resolveCCBootPromptText(
    project,
    member,
    resolvedCodeRoot,
    resolvedVaultRoot,
    teamName
  );

  return buildCCTeammateCommandFromPrompt(
    member,
    project,
    teamName,
    leaderSessionId,
    resolvedCodeRoot,
    promptText
  );
}

export function buildCCNativeTeamLaunchSpec(
  project: TeamRosterProject,
  codeRoot: string,
  vaultRoot: string,
  userBrief?: string
): CCNativeTeamLaunchSpec {
  const launchedAt = new Date();
  const teamName = buildCCNativeTeamName(project, launchedAt);
  const leaderSessionId = generateSessionId();
  const resolvedCodeRoot = codeRoot.trim() || resolveCCTeamCwd(project);
  const resolvedVaultRoot = vaultRoot.trim() || process.cwd();
  const configProject: TeamRosterProject = {
    ...project,
    codeRoot: resolvedCodeRoot,
  };
  const config = buildCCTeamConfig(configProject, teamName, leaderSessionId);

  const memberCommands = orderedProjectMembers(project).map((member) => {
    const bootPromptText = resolveCCBootPromptText(
      configProject,
      member,
      resolvedCodeRoot,
      resolvedVaultRoot,
      teamName,
      member.roleId === project.ceo.roleId ? userBrief : undefined
    );

    return {
      member,
      cwd: resolvedCodeRoot,
      bootPromptText,
      command: buildCCTeammateCommandFromPrompt(
        member,
        configProject,
        teamName,
        leaderSessionId,
        resolvedCodeRoot,
        bootPromptText
      ),
    };
  });

  return {
    teamName,
    leaderSessionId,
    config,
    memberCommands,
  };
}

export function computeTeamLayout(members: TeamRosterMember[]): LayoutSlot[] {
  return computeSharedTeamLayout(members);
}
