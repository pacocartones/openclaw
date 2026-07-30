import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Host-owned correlation captured once for an admitted agent execution. */
export type AgentExecutionAttribution = Readonly<{
  runId: string;
  lifecycleGeneration: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}>;

function requireAttributionField(value: string, field: "runId" | "lifecycleGeneration"): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new TypeError(`Agent execution attribution requires ${field}`);
  }
  return normalized;
}

export function createAgentExecutionAttribution(params: {
  runId: string;
  lifecycleGeneration: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): AgentExecutionAttribution {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  const agentId = normalizeOptionalString(params.agentId);
  return Object.freeze({
    runId: requireAttributionField(params.runId, "runId"),
    lifecycleGeneration: requireAttributionField(params.lifecycleGeneration, "lifecycleGeneration"),
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
  });
}
