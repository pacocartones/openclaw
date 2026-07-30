import { describe, expect, it } from "vitest";
import { createAgentExecutionAttribution } from "./agent-execution-attribution.js";

describe("createAgentExecutionAttribution", () => {
  it("normalizes and freezes host-owned execution correlation", () => {
    const attribution = createAgentExecutionAttribution({
      runId: " run-1 ",
      lifecycleGeneration: " generation-1 ",
      sessionKey: " agent:main:main ",
      sessionId: " session-1 ",
      agentId: " main ",
    });

    expect(attribution).toEqual({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      agentId: "main",
    });
    expect(Object.isFrozen(attribution)).toBe(true);
    expect(Reflect.set(attribution, "sessionId", "replacement")).toBe(false);
  });

  it("leaves unknown optional correlation absent", () => {
    expect(
      createAgentExecutionAttribution({
        runId: "run-1",
        lifecycleGeneration: "generation-1",
        sessionKey: " ",
        sessionId: "",
      }),
    ).toEqual({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });
  });

  it.each([
    ["runId", { runId: " ", lifecycleGeneration: "generation-1" }],
    ["lifecycleGeneration", { runId: "run-1", lifecycleGeneration: "" }],
  ])("rejects a missing required %s", (field, params) => {
    expect(() => createAgentExecutionAttribution(params)).toThrow(
      `Agent execution attribution requires ${field}`,
    );
  });
});
