export const SLOT_OWNER_METHODS = ["claimSlot", "statusSlot", "stopSlot"] as const;
export type SlotOwnerMethod = (typeof SLOT_OWNER_METHODS)[number];

export const SLOT_LEASE_STATES = ["empty", "prepared", "running", "stopped", "stale"] as const;
export type SlotLeaseState = (typeof SLOT_LEASE_STATES)[number];

export const SLOT_OWNERSHIP_OUTCOMES = ["ok", "rejected", "conflict"] as const;
export type SlotOwnershipOutcome = (typeof SLOT_OWNERSHIP_OUTCOMES)[number];

export const SLOT_OWNERSHIP_CANARY_CASE_IDS = [
  "single-slot-happy-path",
  "same-slot-contention",
  "different-slot-parallelism",
  "stale-lease-recovery",
] as const;
export type SlotOwnershipCanaryCaseId = (typeof SLOT_OWNERSHIP_CANARY_CASE_IDS)[number];

export interface SlotOwnershipState {
  slotId: string;
  leaseState: SlotLeaseState;
  debugPort: number;
  vaultDir: string;
  configDir: string;
  obsidianPid: number | null;
  observedAt: string;
}

interface SlotOwnerRequestBase {
  requestId: string;
  slotId: string;
  caller: string;
}

export interface ClaimSlotRequest extends SlotOwnerRequestBase {
  method: "claimSlot";
  fixturePath?: string;
  obsidianVersion?: string;
}

export interface StatusSlotRequest extends SlotOwnerRequestBase {
  method: "statusSlot";
}

export interface StopSlotRequest extends SlotOwnerRequestBase {
  method: "stopSlot";
}

export type SlotOwnerRequest = ClaimSlotRequest | StatusSlotRequest | StopSlotRequest;

export interface SlotOwnershipCanaryPlaceholder {
  id: SlotOwnershipCanaryCaseId;
  summary: string;
  requiredMethods: readonly SlotOwnerMethod[];
  expectedOutcomes: readonly SlotOwnershipOutcome[];
  expectedLeaseStates: readonly SlotLeaseState[];
  placeholder: true;
}

export interface SlotOwnerResponse {
  method: SlotOwnerMethod;
  requestId: string;
  slotId: string;
  caller: string;
  outcome: SlotOwnershipOutcome;
  stateAfter: SlotOwnershipState;
}

export function isSlotOwnerMethod(value: string): value is SlotOwnerMethod {
  return (SLOT_OWNER_METHODS as readonly string[]).includes(value);
}

export function isSlotLeaseState(value: string): value is SlotLeaseState {
  return (SLOT_LEASE_STATES as readonly string[]).includes(value);
}

export function isSlotOwnershipOutcome(value: string): value is SlotOwnershipOutcome {
  return (SLOT_OWNERSHIP_OUTCOMES as readonly string[]).includes(value);
}

export function isSlotOwnershipCanaryCaseId(value: string): value is SlotOwnershipCanaryCaseId {
  return (SLOT_OWNERSHIP_CANARY_CASE_IDS as readonly string[]).includes(value);
}

export function createClaimSlotRequest(input: Omit<ClaimSlotRequest, "method">): ClaimSlotRequest {
  return {
    method: "claimSlot",
    requestId: input.requestId,
    slotId: input.slotId,
    caller: input.caller,
    fixturePath: input.fixturePath,
    obsidianVersion: input.obsidianVersion,
  };
}

export function createStatusSlotRequest(input: Omit<StatusSlotRequest, "method">): StatusSlotRequest {
  return {
    method: "statusSlot",
    requestId: input.requestId,
    slotId: input.slotId,
    caller: input.caller,
  };
}

export function createStopSlotRequest(input: Omit<StopSlotRequest, "method">): StopSlotRequest {
  return {
    method: "stopSlot",
    requestId: input.requestId,
    slotId: input.slotId,
    caller: input.caller,
  };
}

export function createSlotOwnershipState(input: SlotOwnershipState): SlotOwnershipState {
  return {
    slotId: input.slotId,
    leaseState: input.leaseState,
    debugPort: input.debugPort,
    vaultDir: input.vaultDir,
    configDir: input.configDir,
    obsidianPid: input.obsidianPid,
    observedAt: input.observedAt,
  };
}

export function createSlotOwnerResponse(input: SlotOwnerResponse): SlotOwnerResponse {
  return {
    method: input.method,
    requestId: input.requestId,
    slotId: input.slotId,
    caller: input.caller,
    outcome: input.outcome,
    stateAfter: createSlotOwnershipState(input.stateAfter),
  };
}

export const SLOT_OWNERSHIP_CANARY_MATRIX: readonly SlotOwnershipCanaryPlaceholder[] = [
  {
    id: "single-slot-happy-path",
    summary: "claim -> status -> stop on one slot",
    requiredMethods: ["claimSlot", "statusSlot", "stopSlot"],
    expectedOutcomes: ["ok"],
    expectedLeaseStates: ["running", "stopped"],
    placeholder: true,
  },
  {
    id: "same-slot-contention",
    summary: "two callers contend for one slot and one request is rejected",
    requiredMethods: ["claimSlot"],
    expectedOutcomes: ["ok", "rejected"],
    expectedLeaseStates: ["running"],
    placeholder: true,
  },
  {
    id: "different-slot-parallelism",
    summary: "two callers claim different slots without sharing a debug port",
    requiredMethods: ["claimSlot"],
    expectedOutcomes: ["ok"],
    expectedLeaseStates: ["running"],
    placeholder: true,
  },
  {
    id: "stale-lease-recovery",
    summary: "status reports stale before a later claim reclaims the slot",
    requiredMethods: ["claimSlot", "statusSlot"],
    expectedOutcomes: ["ok"],
    expectedLeaseStates: ["stale", "running"],
    placeholder: true,
  },
];
