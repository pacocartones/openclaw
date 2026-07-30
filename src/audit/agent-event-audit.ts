/** Redaction-safe projection from live agent events into durable audit metadata. */
import { createHash } from "node:crypto";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  buildAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { normalizeAgentRunTimeoutPhase } from "../agents/run-timeout-attribution.js";
import { isAllowedToolCallName } from "../agents/tool-call-shared.js";
import {
  isAgentEventLifecycleGenerationCurrent,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { onAgentRunContextRetired } from "../infra/agent-run-context-retirement.js";
import type { TrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { getTrustedToolExecutionLifecycleGeneration } from "../infra/trusted-tool-execution-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildRunInstance,
  createAgentAuditProjectionState,
  deriveProvenance,
  forgetOpenRun,
  hasAuthoritativeRunContext,
  MAX_TRACKED_RUN_PROVENANCE,
  rememberRunStart,
  rememberRunTerminal,
  resolveProvenance,
  resolveToolProvenance,
  type AgentAuditProjectionState,
} from "./agent-event-audit-provenance.js";
import type {
  AuditEventInput,
  AgentRunFinishedAuditTerminal,
  ToolActionAuditEventInput,
} from "./audit-event-types.js";
import { createAuditEventWriter, type AuditEventWriter } from "./audit-event-writer.js";

const log = createSubsystemLogger("audit/events");
let persistenceFailureWarned = false;

export type AgentEventAuditRecorder = {
  record: (event: AgentEventPayload) => void;
  recordTool: (event: TrustedToolExecutionEvent) => void;
  stop: () => Promise<void>;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function auditToolName(value: unknown): string | undefined {
  const toolName = nonEmptyString(value)?.trim();
  if (!toolName) {
    return undefined;
  }
  // Tool lifecycle producers include provider-controlled streams. Preserve
  // only the compact model-facing name contract at the durable boundary.
  return isAllowedToolCallName(toolName, null) ? toolName : "unknown";
}

function auditToolCallId(value: unknown): string | undefined {
  const toolCallId = nonEmptyString(value);
  if (!toolCallId) {
    return undefined;
  }
  // Call ids remain useful for correlation, but their provider-owned bytes
  // are not operator metadata and must never enter the ledger verbatim.
  return `sha256:${createHash("sha256").update(toolCallId).digest("hex")}`;
}

function legacyAuditSourceId(params: {
  runId: string;
  sourceSequence: number;
  occurredAt: number;
  action: string;
}): string {
  // Preserve the original store-owned identity byte-for-byte so replayed
  // run/tool events still deduplicate after the versioned contract refactor.
  return `${params.runId}:${params.sourceSequence}:${params.occurredAt}:${params.action}`;
}

function auditSourceId(
  params: Parameters<typeof legacyAuditSourceId>[0] & { lifecycleGeneration?: string },
): string {
  const legacySourceId = legacyAuditSourceId(params);
  return params.lifecycleGeneration
    ? `lifecycle:${params.lifecycleGeneration}:${legacySourceId}`
    : legacySourceId;
}

function classifyRunTerminal(
  data: Record<string, unknown>,
  phase: "end" | "error",
): {
  outcome: AgentRunTerminalOutcome;
} & AgentRunFinishedAuditTerminal {
  const stopReason = nonEmptyString(data.stopReason);
  const timeoutPhase = normalizeAgentRunTimeoutPhase(data.timeoutPhase);
  const terminalStatus = normalizeOptionalLowercaseString(data.status);
  const explicitlyTimedOut =
    stopReason === "timeout" ||
    timeoutPhase !== undefined ||
    terminalStatus === "timeout" ||
    terminalStatus === "timed_out";
  const explicitlyCancelled =
    !explicitlyTimedOut &&
    (data.aborted === true ||
      stopReason === "aborted" ||
      terminalStatus === "cancelled" ||
      terminalStatus === "canceled" ||
      terminalStatus === "aborted");
  // The terminal helper accepts wait statuses, so normalize explicit lifecycle
  // cancellation to its canonical stop signal without persisting the raw reason.
  const outcomeStopReason = explicitlyCancelled && !explicitlyTimedOut ? "stop" : stopReason;
  const outcome = buildAgentRunTerminalOutcome({
    status: explicitlyTimedOut
      ? "timeout"
      : phase === "error"
        ? "error"
        : explicitlyCancelled
          ? "error"
          : "ok",
    stopReason: outcomeStopReason,
    livenessState: data.livenessState,
    timeoutPhase,
    providerStarted: data.providerStarted,
    startedAt: data.startedAt,
    endedAt: data.endedAt,
  });
  if (outcome.reason === "cancelled" || outcome.reason === "aborted") {
    return { outcome, status: "cancelled", errorCode: "run_cancelled" };
  }
  if (outcome.reason === "hard_timeout" || outcome.reason === "timed_out") {
    return { outcome, status: "timed_out", errorCode: "run_timed_out" };
  }
  if (outcome.reason === "blocked") {
    return { outcome, status: "blocked", errorCode: "run_blocked" };
  }
  return outcome.reason === "completed"
    ? { outcome, status: "succeeded" }
    : { outcome, status: "failed", errorCode: "run_failed" };
}

type AgentAuditProjection = {
  input: AuditEventInput;
  terminal?: { outcome: AgentRunTerminalOutcome; phase: "end" | "error" };
};

function projectAgentEvent(
  state: AgentAuditProjectionState,
  event: AgentEventPayload,
): AgentAuditProjection | undefined {
  const runId = nonEmptyString(event.runId);
  const phase = nonEmptyString(event.data.phase);
  if (!runId || !phase) {
    return undefined;
  }
  const runInstance = buildRunInstance(runId, event.lifecycleGeneration);
  const isLifecycleTerminal =
    event.stream === "lifecycle" && (phase === "end" || phase === "error");
  if (
    event.lifecycleGeneration &&
    !isAgentEventLifecycleGenerationCurrent(event.lifecycleGeneration) &&
    !(isLifecycleTerminal && state.openRunProvenance.has(runInstance))
  ) {
    // Stale starts cannot replace admission. A tracked pre-rotation run may
    // still close its exact instance; rememberRunTerminal keeps the newer
    // active admission authoritative.
    return undefined;
  }
  if (event.stream === "lifecycle" && phase === "start") {
    // Retry starts may reopen a completed instance. rememberRunStart reuses its
    // admitted provenance so replayed identity fields cannot replace authority.
    const provenance = rememberRunStart(
      state,
      runInstance,
      runId,
      deriveProvenance(event),
      event.lifecycleGeneration !== undefined,
    );
    const occurredAt = asDateTimestampMs(event.data.startedAt) ?? event.ts;
    const action = "agent.run.started" as const;
    return {
      input: {
        sourceId: auditSourceId({
          runId,
          sourceSequence: event.seq,
          occurredAt,
          action,
          lifecycleGeneration: event.lifecycleGeneration,
        }),
        sourceSequence: event.seq,
        occurredAt,
        kind: "agent_run",
        action,
        status: "started",
        actorType: provenance.actorType,
        actorId: provenance.agentId,
        agentId: provenance.agentId,
        ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
        ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
        runId,
      },
    };
  }
  if (isLifecycleTerminal) {
    const activeRunInstance = state.activeRunInstanceByRunId.get(runId);
    if (
      !event.lifecycleGeneration &&
      activeRunInstance &&
      activeRunInstance !== runInstance &&
      !state.openRunProvenance.has(runInstance)
    ) {
      // Gateway lifecycle emitters always stamp a generation. A legacy
      // terminal cannot be safely attached to a generated admission, so reject
      // it unless a generation-less start established its own run instance.
      return undefined;
    }
    const provenance = resolveProvenance(state, runInstance, event);
    rememberRunTerminal(state, runInstance, runId, provenance);
    const { outcome, ...terminal } = classifyRunTerminal(event.data, phase);
    const occurredAt = asDateTimestampMs(event.data.endedAt) ?? event.ts;
    const action = "agent.run.finished" as const;
    return {
      input: {
        sourceId: auditSourceId({
          runId,
          sourceSequence: event.seq,
          occurredAt,
          action,
          lifecycleGeneration: event.lifecycleGeneration,
        }),
        sourceSequence: event.seq,
        occurredAt,
        kind: "agent_run",
        action,
        ...terminal,
        actorType: provenance.actorType,
        actorId: provenance.agentId,
        agentId: provenance.agentId,
        ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
        ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
        runId,
      },
      terminal: { outcome, phase },
    };
  }
  return undefined;
}

/** Project the complete trusted tool-execution lifecycle without private diagnostic content. */
function projectToolExecutionEventToAudit(
  state: AgentAuditProjectionState,
  event: TrustedToolExecutionEvent,
): ToolActionAuditEventInput | undefined {
  // Schema quarantine describes tool availability before invocation. Without
  // a call identity it must not become a durable tool-action claim.
  if (
    event.type === "tool.execution.blocked" &&
    event.deniedReason === "unsupported_tool_schema" &&
    !nonEmptyString(event.toolCallId)
  ) {
    return undefined;
  }
  const runId = nonEmptyString(event.runId);
  const toolName = auditToolName(event.toolName);
  if (!runId || !toolName) {
    return undefined;
  }
  const toolCallId = auditToolCallId(event.toolCallId);
  const lifecycleGeneration = getTrustedToolExecutionLifecycleGeneration(event);
  const provenance = resolveToolProvenance(state, runId, event, lifecycleGeneration);
  const occurredAt = asDateTimestampMs(event.sourceTimestampMs) ?? event.ts;
  const attribution = {
    sourceSequence: event.seq,
    occurredAt,
    kind: "tool_action" as const,
    actorType: provenance.actorType,
    actorId: provenance.agentId,
    agentId: provenance.agentId,
    ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
    ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
    runId,
    ...(toolCallId ? { toolCallId } : {}),
    toolName,
  };
  if (event.type === "tool.execution.started") {
    const action = "tool.action.started" as const;
    return {
      sourceId: auditSourceId({
        runId,
        sourceSequence: event.seq,
        occurredAt,
        action,
        lifecycleGeneration,
      }),
      ...attribution,
      action,
      status: "started",
    };
  }
  const errorCategory =
    event.type === "tool.execution.error"
      ? normalizeOptionalLowercaseString(event.errorCategory)
      : undefined;
  const terminalReason = event.type === "tool.execution.error" ? event.terminalReason : undefined;
  const diagnosticErrorCode =
    event.type === "tool.execution.error"
      ? normalizeOptionalLowercaseString(event.errorCode)
      : undefined;
  // Modern producers set terminalReason explicitly; errorCategory is only a
  // legacy fallback and must not override a definitive timeout or failure.
  const toolCancelled =
    terminalReason === "cancelled" ||
    (terminalReason === undefined &&
      (errorCategory === "aborted" ||
        errorCategory === "aborterror" ||
        errorCategory === "cancelled" ||
        errorCategory === "canceled"));
  const toolTimedOut = terminalReason === "timed_out";
  // Unknown is an explicit dependency boundary, not a failed-run inference.
  // Keep it authoritative when enclosing run provenance says cancel or timeout.
  const terminal =
    event.type === "tool.execution.completed"
      ? { status: "succeeded" as const }
      : event.type === "tool.execution.blocked"
        ? { status: "blocked" as const, errorCode: "tool_blocked" as const }
        : diagnosticErrorCode === "tool_outcome_unknown"
          ? { status: "unknown" as const, errorCode: "tool_outcome_unknown" as const }
          : toolCancelled
            ? { status: "cancelled" as const, errorCode: "tool_cancelled" as const }
            : toolTimedOut
              ? { status: "timed_out" as const, errorCode: "tool_timed_out" as const }
              : { status: "failed" as const, errorCode: "tool_failed" as const };
  const action = "tool.action.finished" as const;
  return {
    sourceId: auditSourceId({
      runId,
      sourceSequence: event.seq,
      occurredAt,
      action,
      lifecycleGeneration,
    }),
    ...attribution,
    action,
    ...terminal,
  };
}

/** Create the Gateway-owned non-blocking audit projection and persistence handle. */
export function createAgentEventAuditRecorder(options?: {
  writer?: AuditEventWriter;
  stateDir?: string;
  terminalSettleMs?: number;
}): AgentEventAuditRecorder {
  const projectionState = createAgentAuditProjectionState();
  const writer =
    options?.writer ??
    createAuditEventWriter({
      ...(options?.stateDir ? { stateDir: options.stateDir } : {}),
      onError: (error) => {
        if (!persistenceFailureWarned) {
          persistenceFailureWarned = true;
          log.warn(`audit event persistence failed: ${error}`);
        }
      },
    });
  type TerminalCandidate = NonNullable<AgentAuditProjection["terminal"]> & {
    attemptKey: string;
    input: AuditEventInput;
  };
  type PendingTerminal = TerminalCandidate & {
    timer: ReturnType<typeof setTimeout>;
  };
  const terminalSettleMs = Math.max(
    0,
    Math.floor(options?.terminalSettleMs ?? AGENT_RUN_TERMINAL_RETRY_GRACE_MS),
  );
  const pendingTerminals = new Map<string, PendingTerminal>();
  const rejectedTerminalsByAttempt = new Map<string, TerminalCandidate & { runInstance: string }>();
  const rejectedCountByRunInstance = new Map<string, number>();
  const openRunInstances = new Set<string>();
  const retiredOpenRunInstances = new Set<string>();
  const unownedOpenRunInstances = new Set<string>();
  const settledRunInstances = new Set<string>();
  const attemptEpochByRunInstance = new Map<string, number>();

  const selectTerminalCandidate = (
    existing: TerminalCandidate,
    incoming: TerminalCandidate,
  ): TerminalCandidate => {
    // A bare cleanup end can follow a definitive error without a retry start.
    // Otherwise use the shared sticky timeout/cancellation merge contract.
    const cleanupAfterError =
      existing.phase === "error" &&
      incoming.phase === "end" &&
      incoming.outcome.reason === "completed";
    if (cleanupAfterError) {
      return existing;
    }
    const merged = mergeAgentRunTerminalOutcome(existing.outcome, incoming.outcome);
    return merged === existing.outcome ? existing : incoming;
  };
  const forgetRejectedAttempt = (attemptKey: string) => {
    const rejected = rejectedTerminalsByAttempt.get(attemptKey);
    if (!rejected) {
      return;
    }
    rejectedTerminalsByAttempt.delete(attemptKey);
    const rejectedCount = (rejectedCountByRunInstance.get(rejected.runInstance) ?? 1) - 1;
    if (rejectedCount > 0) {
      rejectedCountByRunInstance.set(rejected.runInstance, rejectedCount);
    } else {
      rejectedCountByRunInstance.delete(rejected.runInstance);
      if (!openRunInstances.has(rejected.runInstance)) {
        attemptEpochByRunInstance.delete(rejected.runInstance);
      }
    }
  };
  const rememberRejectedTerminal = (runInstance: string, incoming: TerminalCandidate) => {
    const existing = rejectedTerminalsByAttempt.get(incoming.attemptKey);
    const selected = existing ? selectTerminalCandidate(existing, incoming) : incoming;
    if (!existing) {
      rejectedCountByRunInstance.set(
        runInstance,
        (rejectedCountByRunInstance.get(runInstance) ?? 0) + 1,
      );
    }
    rejectedTerminalsByAttempt.delete(incoming.attemptKey);
    rejectedTerminalsByAttempt.set(incoming.attemptKey, { ...selected, runInstance });
    if (rejectedTerminalsByAttempt.size > MAX_TRACKED_RUN_PROVENANCE) {
      const oldest = rejectedTerminalsByAttempt.keys().next().value;
      if (oldest !== undefined) {
        forgetRejectedAttempt(oldest);
      }
    }
  };
  const rememberSettled = (runInstance: string) => {
    settledRunInstances.delete(runInstance);
    settledRunInstances.add(runInstance);
    if (settledRunInstances.size > MAX_TRACKED_RUN_PROVENANCE) {
      const oldest = settledRunInstances.values().next().value;
      if (oldest !== undefined) {
        settledRunInstances.delete(oldest);
      }
    }
  };
  const clearPending = (runInstance: string) => {
    const pending = pendingTerminals.get(runInstance);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pendingTerminals.delete(runInstance);
  };
  const flushPending = (runInstance: string) => {
    const pending = pendingTerminals.get(runInstance);
    if (!pending) {
      return;
    }
    clearPending(runInstance);
    openRunInstances.delete(runInstance);
    const rejected = rejectedTerminalsByAttempt.get(pending.attemptKey);
    const selected = rejected ? selectTerminalCandidate(rejected, pending) : pending;
    if (writer.record(selected.input)) {
      forgetRejectedAttempt(selected.attemptKey);
      const runId = nonEmptyString(pending.input.runId);
      if (runId) {
        forgetOpenRun(projectionState, runInstance, runId);
      }
      retiredOpenRunInstances.delete(runInstance);
      unownedOpenRunInstances.delete(runInstance);
      rememberSettled(runInstance);
      if (!rejectedCountByRunInstance.has(runInstance)) {
        attemptEpochByRunInstance.delete(runInstance);
      }
    } else {
      rememberRejectedTerminal(runInstance, selected);
    }
  };
  const scheduleTerminal = (runInstance: string, incoming: TerminalCandidate) => {
    const existing = pendingTerminals.get(runInstance);
    const selected = existing ? selectTerminalCandidate(existing, incoming) : incoming;
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => flushPending(runInstance), terminalSettleMs);
    timer.unref?.();
    pendingTerminals.delete(runInstance);
    pendingTerminals.set(runInstance, { ...selected, timer });
    if (pendingTerminals.size > MAX_TRACKED_RUN_PROVENANCE) {
      const oldest = pendingTerminals.keys().next().value;
      if (oldest !== undefined) {
        flushPending(oldest);
      }
    }
  };
  const unsubscribeRunContextRetirement = onAgentRunContextRetired(
    ({ runId, lifecycleGeneration, reason }) => {
      const runInstance = buildRunInstance(runId, lifecycleGeneration);
      if (reason === "replaced" && projectionState.openRunProvenance.has(runInstance)) {
        retiredOpenRunInstances.delete(runInstance);
        retiredOpenRunInstances.add(runInstance);
        unownedOpenRunInstances.delete(runInstance);
        if (retiredOpenRunInstances.size > MAX_TRACKED_RUN_PROVENANCE) {
          const oldest = retiredOpenRunInstances.values().next().value;
          if (oldest !== undefined) {
            const separator = oldest.indexOf("\0");
            const retiredRunId = separator >= 0 ? oldest.slice(separator + 1) : oldest;
            retiredOpenRunInstances.delete(oldest);
            forgetOpenRun(projectionState, oldest, retiredRunId);
            openRunInstances.delete(oldest);
            if (!pendingTerminals.has(oldest) && !rejectedCountByRunInstance.has(oldest)) {
              attemptEpochByRunInstance.delete(oldest);
            }
          }
        }
        return;
      }
      forgetOpenRun(projectionState, runInstance, runId);
      openRunInstances.delete(runInstance);
      retiredOpenRunInstances.delete(runInstance);
      unownedOpenRunInstances.delete(runInstance);
      if (!pendingTerminals.has(runInstance) && !rejectedCountByRunInstance.has(runInstance)) {
        attemptEpochByRunInstance.delete(runInstance);
      }
    },
  );
  const trimUnownedOpenRuns = () => {
    while (unownedOpenRunInstances.size > MAX_TRACKED_RUN_PROVENANCE) {
      const runInstance = unownedOpenRunInstances.values().next().value;
      if (runInstance === undefined) {
        break;
      }
      const separator = runInstance.indexOf("\0");
      const runId = separator >= 0 ? runInstance.slice(separator + 1) : runInstance;
      unownedOpenRunInstances.delete(runInstance);
      forgetOpenRun(projectionState, runInstance, runId);
      openRunInstances.delete(runInstance);
      if (!pendingTerminals.has(runInstance) && !rejectedCountByRunInstance.has(runInstance)) {
        attemptEpochByRunInstance.delete(runInstance);
      }
    }
  };

  return {
    record: (event) => {
      const projection = projectAgentEvent(projectionState, event);
      if (!projection) {
        return;
      }
      const runInstance = buildRunInstance(event.runId, event.lifecycleGeneration);
      if (!projection.terminal) {
        const alreadyOpen = openRunInstances.has(runInstance);
        clearPending(runInstance);
        settledRunInstances.delete(runInstance);
        if (alreadyOpen) {
          return;
        }
        // Retry starts cancel a provisional terminal for the same logical run.
        // A writer-rejected terminal already crossed the settle boundary and
        // remains a prior attempt; queue pressure must not rewrite that history.
        attemptEpochByRunInstance.set(
          runInstance,
          (attemptEpochByRunInstance.get(runInstance) ?? 0) + 1,
        );
        openRunInstances.add(runInstance);
        writer.record(projection.input);
        if (hasAuthoritativeRunContext(runInstance, event.runId)) {
          unownedOpenRunInstances.delete(runInstance);
        } else {
          unownedOpenRunInstances.delete(runInstance);
          unownedOpenRunInstances.add(runInstance);
        }
        trimUnownedOpenRuns();
        return;
      }
      if (settledRunInstances.has(runInstance)) {
        return;
      }
      if (
        projection.terminal.outcome.reason === "completed" &&
        !pendingTerminals.has(runInstance)
      ) {
        const attemptKey = `${runInstance}\0${attemptEpochByRunInstance.get(runInstance) ?? 0}`;
        const incoming = {
          attemptKey,
          input: projection.input,
          ...projection.terminal,
        };
        const rejected = rejectedTerminalsByAttempt.get(attemptKey);
        const selected = rejected ? selectTerminalCandidate(rejected, incoming) : incoming;
        openRunInstances.delete(runInstance);
        if (writer.record(selected.input)) {
          forgetRejectedAttempt(attemptKey);
          forgetOpenRun(projectionState, runInstance, event.runId);
          retiredOpenRunInstances.delete(runInstance);
          unownedOpenRunInstances.delete(runInstance);
          rememberSettled(runInstance);
          if (!rejectedCountByRunInstance.has(runInstance)) {
            attemptEpochByRunInstance.delete(runInstance);
          }
        } else {
          rememberRejectedTerminal(runInstance, selected);
        }
        return;
      }
      scheduleTerminal(runInstance, {
        attemptKey: `${runInstance}\0${attemptEpochByRunInstance.get(runInstance) ?? 0}`,
        input: projection.input,
        ...projection.terminal,
      });
    },
    recordTool: (event) => {
      const input = projectToolExecutionEventToAudit(projectionState, event);
      if (input) {
        writer.record(input);
      }
    },
    stop: async () => {
      for (const runInstance of pendingTerminals.keys()) {
        flushPending(runInstance);
      }
      try {
        await writer.stop(
          [...rejectedTerminalsByAttempt.values()].map((rejected) => rejected.input),
        );
      } finally {
        unsubscribeRunContextRetirement();
        // Admission state is lifecycle-owned, not an LRU cache. Context
        // retirement handles abandoned runs while shutdown releases the rest.
        projectionState.openRunProvenance.clear();
        projectionState.runProvenance.clear();
        projectionState.activeRunInstanceByRunId.clear();
        projectionState.seenRunInstances.clear();
        rejectedTerminalsByAttempt.clear();
        rejectedCountByRunInstance.clear();
        retiredOpenRunInstances.clear();
        unownedOpenRunInstances.clear();
        attemptEpochByRunInstance.clear();
      }
    },
  };
}
