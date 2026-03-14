export type ManagedTerminalStatus = "idle" | "active" | "tool" | "waiting" | "exited" | "shell" | "running" | "crashed";
export type DerivedRuntimeState = "launching" | "busy" | "waiting" | "exited" | "failed";
export type DerivedDeliveryState = "unknown" | "pending" | "ready" | "degraded";

export interface DeliveryObservation {
  address: string | null;
  firstDeliveryReadyAt: number | null;
  lastDeliveryPollAt: number | null;
  lastDeliveryError: string | null;
}

export interface ManagedRoleStatus {
  teamId: string;
  roleId: string;
  address: string | null;
  runtime: DerivedRuntimeState;
  delivery: DerivedDeliveryState;
  terminalStatus: ManagedTerminalStatus;
  firstDeliveryReadyAt: number | null;
  lastDeliveryPollAt: number | null;
  lastDeliveryError: string | null;
}

export interface ManagedRoleStatusInput {
  teamId: string;
  roleId: string;
  address?: string | null;
  observation?: DeliveryObservation;
  terminalStatus: ManagedTerminalStatus;
}

export function createDeliveryObservation(address: string | null = null): DeliveryObservation {
  return {
    address,
    firstDeliveryReadyAt: null,
    lastDeliveryPollAt: null,
    lastDeliveryError: null,
  };
}

export function deriveRuntimeState(status: ManagedTerminalStatus): DerivedRuntimeState {
  switch (status) {
    case "shell":
    case "running":
      return "launching";
    case "active":
    case "tool":
      return "busy";
    case "waiting":
    case "idle":
      return "waiting";
    case "exited":
      return "exited";
    case "crashed":
      return "failed";
  }
}

export function deriveManagedDeliveryState(observation: DeliveryObservation | undefined): DerivedDeliveryState {
  if (!observation) return "pending";
  if (observation.firstDeliveryReadyAt === null) return "pending";
  if (observation.lastDeliveryError) return "degraded";
  return "ready";
}

export function buildManagedRoleStatus(input: ManagedRoleStatusInput): ManagedRoleStatus {
  const observation = input.observation;

  return {
    teamId: input.teamId,
    roleId: input.roleId,
    address: observation?.address ?? input.address ?? null,
    runtime: deriveRuntimeState(input.terminalStatus),
    delivery: deriveManagedDeliveryState(observation),
    terminalStatus: input.terminalStatus,
    firstDeliveryReadyAt: observation?.firstDeliveryReadyAt ?? null,
    lastDeliveryPollAt: observation?.lastDeliveryPollAt ?? null,
    lastDeliveryError: observation?.lastDeliveryError ?? null,
  };
}
