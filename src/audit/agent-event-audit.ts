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
import {
  getTrustedToolExecutionLifecycleGeneration,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type {
  AuditEventInput,
  AgentRunFinishedAuditTerminal,
  ToolActionAuditEventInput,
} from "./audit-event-types.js";
import { createAuditEventWriter, type AuditEventWriter } from "./audit-event-writer.js";

type RunProvenance = {
  actorType: "agent" | "system";
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
};

const runProvenance = new Map<string, RunProvenance>();
const activeRunInstanceByRunId = new Map<string, string>();
const startedRunInstances = new Set<string>();
const MAX_TRACKED_RUN_PROVENANCE = 1_024;
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

function buildRunInstance(runId: string, lifecycleGeneration?: string): string {
  return `${lifecycleGeneration ?? "unknown"}\0${runId}`;
}

function trimRunProvenance(): void {
  while (runProvenance.size > MAX_TRACKED_RUN_PROVENANCE) {
    const oldestRunInstance = runProvenance.keys().next().value;
    if (oldestRunInstance === undefined) {
      break;
    }
    runProvenance.delete(oldestRunInstance);
    startedRunInstances.delete(oldestRunInstance);
    for (const [trackedRunId, activeRunInstance] of activeRunInstanceByRunId) {
      if (activeRunInstance === oldestRunInstance) {
        activeRunInstanceByRunId.delete(trackedRunId);
      }
    }
  }
}

function rememberRunStart(
  runInstance: string,
  runId: string,
  provenance: RunProvenance,
  hasLifecycleGeneration: boolean,
): void {
  const startAlreadySeen = startedRunInstances.has(runInstance);
  runProvenance.delete(runInstance);
  runProvenance.set(runInstance, provenance);
  startedRunInstances.add(runInstance);
  const activeRunInstance = activeRunInstanceByRunId.get(runId);
  const canReplaceActive =
    hasLifecycleGeneration || !activeRunInstance || activeRunInstance === runInstance;
  if (
    canReplaceActive &&
    (!activeRunInstance || activeRunInstance === runInstance || !startAlreadySeen)
  ) {
    activeRunInstanceByRunId.delete(runId);
    activeRunInstanceByRunId.set(runId, runInstance);
  }
  trimRunProvenance();
}

function rememberRunTerminal(runInstance: string, runId: string, provenance: RunProvenance): void {
  const remembered = runProvenance.get(runInstance) ?? provenance;
  runProvenance.delete(runInstance);
  runProvenance.set(runInstance, remembered);
  const activeRunInstance = activeRunInstanceByRunId.get(runId);
  if (!activeRunInstance || activeRunInstance === runInstance) {
    activeRunInstanceByRunId.set(runId, runInstance);
  }
  trimRunProvenance();
}

function deriveProvenance(event: {
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

function resolveProvenance(
  runInstance: string,
  event: { agentId?: unknown; sessionKey?: unknown; sessionId?: unknown },
): RunProvenance {
  return runProvenance.get(runInstance) ?? deriveProvenance(event);
}

function resolveToolProvenance(runId: string, event: TrustedToolExecutionEvent) {
  const lifecycleGeneration = getTrustedToolExecutionLifecycleGeneration(event);
  const runInstance = lifecycleGeneration
    ? buildRunInstance(runId, lifecycleGeneration)
    : (activeRunInstanceByRunId.get(runId) ?? buildRunInstance(runId));
  const observed = resolveProvenance(runInstance, event);
  const remembered = runProvenance.get(runInstance);
  // Lifecycle start owns canonical run identity. Once remembered, tool
  // diagnostics cannot fill unknown fields or replace the admitted principal.
  return remembered ?? observed;
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

function projectAgentEvent(event: AgentEventPayload): AgentAuditProjection | undefined {
  const runId = nonEmptyString(event.runId);
  const phase = nonEmptyString(event.data.phase);
  if (!runId || !phase) {
    return undefined;
  }
  if (
    event.lifecycleGeneration &&
    !isAgentEventLifecycleGenerationCurrent(event.lifecycleGeneration)
  ) {
    // The live emitter rejects stale generations before this boundary. Keep
    // the recorder defensive so replayed/late events cannot replace admission.
    return undefined;
  }
  const runInstance = buildRunInstance(runId, event.lifecycleGeneration);
  if (event.stream === "lifecycle" && phase === "start") {
    const provenance = deriveProvenance(event);
    rememberRunStart(runInstance, runId, provenance, event.lifecycleGeneration !== undefined);
    const occurredAt = asDateTimestampMs(event.data.startedAt) ?? event.ts;
    const action = "agent.run.started" as const;
    return {
      input: {
        sourceId: legacyAuditSourceId({
          runId,
          sourceSequence: event.seq,
          occurredAt,
          action,
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
  if (event.stream === "lifecycle" && (phase === "end" || phase === "error")) {
    const provenance = resolveProvenance(runInstance, event);
    rememberRunTerminal(runInstance, runId, provenance);
    const { outcome, ...terminal } = classifyRunTerminal(event.data, phase);
    const occurredAt = asDateTimestampMs(event.data.endedAt) ?? event.ts;
    const action = "agent.run.finished" as const;
    return {
      input: {
        sourceId: legacyAuditSourceId({
          runId,
          sourceSequence: event.seq,
          occurredAt,
          action,
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
  const provenance = resolveToolProvenance(runId, event);
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
      sourceId: legacyAuditSourceId({
        runId,
        sourceSequence: event.seq,
        occurredAt,
        action,
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
    sourceId: legacyAuditSourceId({
      runId,
      sourceSequence: event.seq,
      occurredAt,
      action,
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
  type PendingTerminal = NonNullable<AgentAuditProjection["terminal"]> & {
    input: AuditEventInput;
    timer: ReturnType<typeof setTimeout>;
  };
  const terminalSettleMs = Math.max(
    0,
    Math.floor(options?.terminalSettleMs ?? AGENT_RUN_TERMINAL_RETRY_GRACE_MS),
  );
  const pendingTerminals = new Map<string, PendingTerminal>();
  const openRunInstances = new Set<string>();
  const settledRunInstances = new Set<string>();

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
    if (writer.record(pending.input)) {
      rememberSettled(runInstance);
    }
  };
  const scheduleTerminal = (runInstance: string, incoming: Omit<PendingTerminal, "timer">) => {
    const existing = pendingTerminals.get(runInstance);
    let selected = incoming;
    if (existing) {
      // A bare cleanup end can follow a definitive error without a retry start.
      // Otherwise use the shared sticky timeout/cancellation merge contract.
      const cleanupAfterError =
        existing.phase === "error" &&
        incoming.phase === "end" &&
        incoming.outcome.reason === "completed";
      if (cleanupAfterError) {
        selected = existing;
      } else {
        const merged = mergeAgentRunTerminalOutcome(existing.outcome, incoming.outcome);
        selected = merged === existing.outcome ? existing : incoming;
      }
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

  return {
    record: (event) => {
      const projection = projectAgentEvent(event);
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
        // Keep the original start so one run cannot acquire unmatched starts.
        openRunInstances.add(runInstance);
        writer.record(projection.input);
        return;
      }
      if (settledRunInstances.has(runInstance)) {
        return;
      }
      if (
        projection.terminal.outcome.reason === "completed" &&
        !pendingTerminals.has(runInstance)
      ) {
        openRunInstances.delete(runInstance);
        if (writer.record(projection.input)) {
          rememberSettled(runInstance);
        }
        return;
      }
      scheduleTerminal(runInstance, { input: projection.input, ...projection.terminal });
    },
    recordTool: (event) => {
      const input = projectToolExecutionEventToAudit(event);
      if (input) {
        writer.record(input);
      }
    },
    stop: async () => {
      for (const runInstance of pendingTerminals.keys()) {
        flushPending(runInstance);
      }
      await writer.stop();
    },
  };
}
