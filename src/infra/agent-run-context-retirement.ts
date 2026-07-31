import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

type AgentRunContextRetirementEvent = {
  runId: string;
  lifecycleGeneration: string;
  reason: "cleared" | "replaced" | "reset" | "swept";
};

const AGENT_RUN_CONTEXT_RETIREMENT_LISTENERS_KEY = Symbol.for(
  "openclaw.agentRunContextRetirement.listeners",
);

function getAgentRunContextRetirementListeners() {
  return resolveGlobalSingleton<Set<(event: AgentRunContextRetirementEvent) => void>>(
    AGENT_RUN_CONTEXT_RETIREMENT_LISTENERS_KEY,
    () => new Set(),
  );
}

function notifyAgentRunContextRetired(event: AgentRunContextRetirementEvent): void {
  notifyListeners(getAgentRunContextRetirementListeners(), event);
}

export function retireAgentRunContext(
  runId: string,
  lifecycleGeneration: string | undefined,
  reason: AgentRunContextRetirementEvent["reason"],
): void {
  if (lifecycleGeneration) {
    notifyAgentRunContextRetired({ runId, lifecycleGeneration, reason });
  }
}

export function onAgentRunContextRetired(
  listener: (event: AgentRunContextRetirementEvent) => void,
) {
  return registerListener(getAgentRunContextRetirementListeners(), listener);
}
