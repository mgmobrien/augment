export interface LaunchMemberLike {
  roleId: string;
  isLead: boolean;
}

export interface LaunchProjectLike<Member extends LaunchMemberLike = LaunchMemberLike> {
  projectId: string;
  projectDisplayName: string;
  ceo: Member;
  members: Member[];
}

export interface MemberLaunchSpec<Member extends LaunchMemberLike = LaunchMemberLike> {
  member: Member;
  bootPrompt: string;
  cwd: string;
}

export interface TeamLaunchSpec<
  Member extends LaunchMemberLike = LaunchMemberLike,
  Project extends LaunchProjectLike<Member> = LaunchProjectLike<Member>,
> {
  project: Project;
  teamId: string;
  specs: MemberLaunchSpec<Member>[];
}

export interface LayoutSlot<Member extends LaunchMemberLike = LaunchMemberLike> {
  member: Member;
  column: number;
  row: number;
}

export interface CCTeamConfigMember {
  agentId: string;
  name: string;
  agentType: string;
  model: string;
  joinedAt: number;
  tmuxPaneId: string;
  cwd: string;
  subscriptions: string[];
}

export interface CCTeamConfig {
  name: string;
  leadAgentId: string;
  leadSessionId: string;
  members: CCTeamConfigMember[];
}

export interface CCNativeMemberCommandSpec<Member extends LaunchMemberLike = LaunchMemberLike> {
  member: Member;
  command: string;
  cwd: string;
  bootPromptText: string;
}

export interface CCNativeTeamLaunchSpec<Member extends LaunchMemberLike = LaunchMemberLike> {
  teamName: string;
  leaderSessionId: string;
  config: CCTeamConfig;
  memberCommands: CCNativeMemberCommandSpec<Member>[];
}

export interface BuildCCTeamConfigOptions {
  cwd: string;
  joinedAt: number;
  leadModel?: string;
  memberModel?: string;
}

const DEFAULT_CC_TEAM_LEAD_MODEL = "claude-opus-4-6";
const DEFAULT_CC_TEAM_MEMBER_MODEL = "claude-sonnet-4-6";

export const CC_TEAM_COLOR_PALETTE = ["blue", "green", "yellow", "magenta", "cyan", "red", "white"] as const;

export function formatLaunchTimestamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}-${milliseconds}`;
}

export function orderedProjectMembers<
  Member extends LaunchMemberLike,
  Project extends LaunchProjectLike<Member>,
>(project: Project): Member[] {
  return [
    project.ceo,
    ...project.members.filter((member) => member.roleId !== project.ceo.roleId),
  ];
}

export function buildManagedTeamId<
  Member extends LaunchMemberLike,
  Project extends LaunchProjectLike<Member>,
>(project: Project, launchedAt: Date): string {
  const displayName = encodeURIComponent(project.projectDisplayName.trim() || project.projectId);
  return `${project.projectId}::${displayName}::${formatLaunchTimestamp(launchedAt)}`;
}

export function buildCCNativeTeamName<
  Member extends LaunchMemberLike,
  Project extends LaunchProjectLike<Member>,
>(project: Project, launchedAt: Date): string {
  return `${project.projectId}-${formatLaunchTimestamp(launchedAt)}`;
}

export function buildCCAgentId<Member extends LaunchMemberLike>(member: Member, teamName: string): string {
  return `${member.roleId}@${teamName}`;
}

export function resolveCCColor<
  Member extends LaunchMemberLike,
  Project extends LaunchProjectLike<Member>,
>(project: Project, member: Member): string {
  const index = orderedProjectMembers(project).findIndex(
    (candidate) => candidate.roleId === member.roleId
  );
  const colorIndex = index >= 0 ? index : 0;
  return CC_TEAM_COLOR_PALETTE[colorIndex % CC_TEAM_COLOR_PALETTE.length];
}

export function buildCCTeamConfigContract<
  Member extends LaunchMemberLike,
  Project extends LaunchProjectLike<Member>,
>(
  project: Project,
  teamName: string,
  leaderSessionId: string,
  options: BuildCCTeamConfigOptions
): CCTeamConfig {
  const leadModel = options.leadModel ?? DEFAULT_CC_TEAM_LEAD_MODEL;
  const memberModel = options.memberModel ?? DEFAULT_CC_TEAM_MEMBER_MODEL;

  return {
    name: teamName,
    leadAgentId: buildCCAgentId(project.ceo, teamName),
    leadSessionId: leaderSessionId,
    members: orderedProjectMembers(project).map((member) => ({
      agentId: buildCCAgentId(member, teamName),
      name: member.roleId,
      agentType: member.isLead ? "team-lead" : member.roleId,
      model: member.roleId === project.ceo.roleId ? leadModel : memberModel,
      joinedAt: options.joinedAt,
      tmuxPaneId: "",
      cwd: options.cwd,
      subscriptions: [],
    })),
  };
}

export function computeTeamLayout<Member extends LaunchMemberLike>(
  members: Member[]
): LayoutSlot<Member>[] {
  if (members.length === 0) return [];

  const ceo = members.find((member) => member.isLead) ?? members[0];
  const others = members.filter((member) => member.roleId !== ceo.roleId);
  const middleCount = Math.ceil(others.length / 2);

  const slots: LayoutSlot<Member>[] = [
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
