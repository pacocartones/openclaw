import type { AgentExecutionAttribution } from "./agent-execution-attribution.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

type OpenClawCodingToolsOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;

type OpenClawCodingToolsInternalOptions = OpenClawCodingToolsOptions & {
  /** Host-owned correlation intentionally absent from the plugin SDK signature. */
  attribution?: AgentExecutionAttribution;
};

const createOpenClawCodingToolsInternal = createOpenClawCodingTools as (
  options?: OpenClawCodingToolsInternalOptions,
) => ReturnType<typeof createOpenClawCodingTools>;

export function createOpenClawCodingToolsForRuntime(
  options?: OpenClawCodingToolsInternalOptions,
): ReturnType<typeof createOpenClawCodingTools> {
  return createOpenClawCodingToolsInternal(options);
}
