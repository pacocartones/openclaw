import type { RunCliAgentParams } from "./types.js";

/** Projects admitted execution identity over legacy flat CLI-run fields. */
export function bindCliRunExecutionAttribution(params: RunCliAgentParams): RunCliAgentParams {
  const attribution = params.attribution;
  if (!attribution) {
    return params;
  }
  if (!attribution.sessionId) {
    throw new TypeError("CLI execution attribution requires sessionId");
  }
  const {
    runId: _legacyRunId,
    lifecycleGeneration: _legacyLifecycleGeneration,
    sessionKey: _legacySessionKey,
    sessionId: _legacySessionId,
    agentId: _legacyAgentId,
    ...run
  } = params;
  return {
    ...run,
    runId: attribution.runId,
    lifecycleGeneration: attribution.lifecycleGeneration,
    sessionId: attribution.sessionId,
    ...(attribution.sessionKey ? { sessionKey: attribution.sessionKey } : {}),
    ...(attribution.agentId ? { agentId: attribution.agentId } : {}),
  };
}
