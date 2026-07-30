import type { HookContext } from "./agent-tools.before-tool-call.types.js";

export type ToolExecutionCorrelation = Readonly<{
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
}>;

/**
 * Admission attribution is authoritative when present. Flat fields remain
 * only for legacy/internal callers that have not entered the run lifecycle.
 */
export function resolveToolExecutionCorrelation(ctx?: HookContext): ToolExecutionCorrelation {
  if (ctx?.attribution) {
    return ctx.attribution;
  }
  return {
    ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx?.runId ? { runId: ctx.runId } : {}),
  };
}
