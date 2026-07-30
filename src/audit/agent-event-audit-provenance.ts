import { getAgentRunContext } from "../infra/agent-events.js";
import type { TrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

export type RunProvenance = {
  actorType: "agent" | "system";
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
};

export type AgentAuditProjectionState = {
  runProvenance: Map<string, RunProvenance>;
  openRunProvenance: Map<string, RunProvenance>;
  activeRunInstanceByRunId: Map<string, string>;
  seenRunInstances: Set<string>;
};

export const MAX_TRACKED_RUN_PROVENANCE = 1_024;

export function buildRunInstance(runId: string, lifecycleGeneration?: string): string {
  return `${lifecycleGeneration ?? "unknown"}\0${runId}`;
}

export function createAgentAuditProjectionState(): AgentAuditProjectionState {
  return {
    runProvenance: new Map(),
    openRunProvenance: new Map(),
    activeRunInstanceByRunId: new Map(),
    seenRunInstances: new Set(),
  };
}

function trimRunProvenance(state: AgentAuditProjectionState): void {
  while (state.runProvenance.size > MAX_TRACKED_RUN_PROVENANCE) {
    const oldestRunInstance = state.runProvenance.keys().next().value;
    if (oldestRunInstance === undefined) {
      break;
    }
    state.runProvenance.delete(oldestRunInstance);
    if (!state.openRunProvenance.has(oldestRunInstance)) {
      state.seenRunInstances.delete(oldestRunInstance);
    }
    for (const [trackedRunId, activeRunInstance] of state.activeRunInstanceByRunId) {
      if (
        activeRunInstance === oldestRunInstance &&
        !state.openRunProvenance.has(oldestRunInstance)
      ) {
        state.activeRunInstanceByRunId.delete(trackedRunId);
      }
    }
  }
}

export function rememberRunStart(
  state: AgentAuditProjectionState,
  runInstance: string,
  runId: string,
  provenance: RunProvenance,
  hasLifecycleGeneration: boolean,
): RunProvenance {
  if (state.seenRunInstances.has(runInstance)) {
    const remembered =
      state.openRunProvenance.get(runInstance) ??
      state.runProvenance.get(runInstance) ??
      provenance;
    state.openRunProvenance.set(runInstance, remembered);
    const activeRunInstance = state.activeRunInstanceByRunId.get(runId);
    if (hasLifecycleGeneration || !activeRunInstance || activeRunInstance === runInstance) {
      state.activeRunInstanceByRunId.delete(runId);
      state.activeRunInstanceByRunId.set(runId, runInstance);
    }
    return remembered;
  }
  state.runProvenance.delete(runInstance);
  state.openRunProvenance.set(runInstance, provenance);
  state.seenRunInstances.add(runInstance);
  const activeRunInstance = state.activeRunInstanceByRunId.get(runId);
  if (hasLifecycleGeneration || !activeRunInstance || activeRunInstance === runInstance) {
    state.activeRunInstanceByRunId.delete(runId);
    state.activeRunInstanceByRunId.set(runId, runInstance);
  }
  return provenance;
}

export function rememberRunTerminal(
  state: AgentAuditProjectionState,
  runInstance: string,
  runId: string,
  provenance: RunProvenance,
): void {
  const remembered =
    state.openRunProvenance.get(runInstance) ?? state.runProvenance.get(runInstance) ?? provenance;
  state.runProvenance.delete(runInstance);
  state.runProvenance.set(runInstance, remembered);
  const activeRunInstance = state.activeRunInstanceByRunId.get(runId);
  if (!activeRunInstance || activeRunInstance === runInstance) {
    state.activeRunInstanceByRunId.set(runId, runInstance);
  }
  trimRunProvenance(state);
}

export function forgetOpenRun(
  state: AgentAuditProjectionState,
  runInstance: string,
  runId: string,
): void {
  state.openRunProvenance.delete(runInstance);
  if (
    !state.runProvenance.has(runInstance) &&
    state.activeRunInstanceByRunId.get(runId) === runInstance
  ) {
    state.activeRunInstanceByRunId.delete(runId);
  }
  if (!state.runProvenance.has(runInstance)) {
    state.seenRunInstances.delete(runInstance);
  }
}

export function hasAuthoritativeRunContext(runInstance: string, runId: string): boolean {
  const separator = runInstance.indexOf("\0");
  const lifecycleGeneration = separator >= 0 ? runInstance.slice(0, separator) : "unknown";
  return (
    lifecycleGeneration !== "unknown" &&
    getAgentRunContext(runId)?.lifecycleGeneration === lifecycleGeneration
  );
}

export function deriveProvenance(event: {
  agentId?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
}): RunProvenance {
  const sessionKey = nonEmptyString(event.sessionKey);
  const sessionId = nonEmptyString(event.sessionId);
  const eventAgentId = nonEmptyString(event.agentId);
  const sessionAgentId = sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined;
  const agentId = eventAgentId ?? sessionAgentId ?? "unknown";
  const actorType = eventAgentId || sessionAgentId ? "agent" : "system";
  return { actorType, agentId, sessionKey, sessionId };
}

export function resolveProvenance(
  state: AgentAuditProjectionState,
  runInstance: string,
  event: { agentId?: unknown; sessionKey?: unknown; sessionId?: unknown },
): RunProvenance {
  return (
    state.openRunProvenance.get(runInstance) ??
    state.runProvenance.get(runInstance) ??
    deriveProvenance(event)
  );
}

export function resolveToolProvenance(
  state: AgentAuditProjectionState,
  runId: string,
  event: TrustedToolExecutionEvent,
  lifecycleGeneration?: string,
) {
  const runInstance = lifecycleGeneration
    ? buildRunInstance(runId, lifecycleGeneration)
    : (state.activeRunInstanceByRunId.get(runId) ?? buildRunInstance(runId));
  const observed = resolveProvenance(state, runInstance, event);
  const remembered =
    state.openRunProvenance.get(runInstance) ?? state.runProvenance.get(runInstance);
  // Lifecycle start owns canonical run identity. Once remembered, tool
  // diagnostics cannot fill unknown fields or replace the admitted principal.
  return remembered ?? observed;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
