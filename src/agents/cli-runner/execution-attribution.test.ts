import { describe, expect, it } from "vitest";
import { createAgentExecutionAttribution } from "../agent-execution-attribution.js";
import { bindCliRunExecutionAttribution } from "./execution-attribution.js";
import type { RunCliAgentParams } from "./types.js";

function createRunParams(overrides: Partial<RunCliAgentParams> = {}): RunCliAgentParams {
  return {
    sessionId: "legacy-session",
    sessionKey: "agent:legacy:main",
    agentId: "legacy-agent",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "test",
    provider: "test-cli",
    timeoutMs: 1_000,
    runId: "legacy-run",
    lifecycleGeneration: "legacy-generation",
    ...overrides,
  };
}

describe("bindCliRunExecutionAttribution", () => {
  it("projects admitted identity over legacy flat fields", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "admitted-run",
      lifecycleGeneration: "admitted-generation",
      sessionKey: "agent:main:main",
      sessionId: "admitted-session",
      agentId: "main",
    });

    expect(bindCliRunExecutionAttribution(createRunParams({ attribution }))).toMatchObject({
      attribution,
      runId: "admitted-run",
      lifecycleGeneration: "admitted-generation",
      sessionKey: "agent:main:main",
      sessionId: "admitted-session",
      agentId: "main",
    });
  });

  it("clears legacy optional identity absent from admitted attribution", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "admitted-run",
      lifecycleGeneration: "admitted-generation",
      sessionId: "admitted-session",
    });

    const bound = bindCliRunExecutionAttribution(createRunParams({ attribution }));

    expect(bound).not.toHaveProperty("sessionKey");
    expect(bound).not.toHaveProperty("agentId");
    expect(bound.sessionId).toBe("admitted-session");
  });

  it("rejects admitted CLI attribution without its required session id", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "admitted-run",
      lifecycleGeneration: "admitted-generation",
    });

    expect(() => bindCliRunExecutionAttribution(createRunParams({ attribution }))).toThrow(
      "CLI execution attribution requires sessionId",
    );
  });
});
