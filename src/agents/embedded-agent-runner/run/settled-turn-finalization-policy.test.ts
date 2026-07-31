import { describe, expect, it } from "vitest";
import {
  resolveCodeModeContinuationToolPolicy,
  resolveEmptyResponseRetryInstruction,
} from "./incomplete-turn.js";
import {
  consumeForceReadOnlyToolsForNextAttempt,
  consumeForceRestartSafeToolsForNextAttempt,
  createEmbeddedRunTerminalRetryState,
} from "./terminal-retry-state.js";

describe("settled Code Mode continuation policy", () => {
  it("uses normal tools after reads and read-only tools after mutations", () => {
    expect(
      resolveCodeModeContinuationToolPolicy({
        codeModeEngaged: true,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      }),
    ).toBe("normal");
    expect(
      resolveCodeModeContinuationToolPolicy({
        codeModeEngaged: true,
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: true },
      }),
    ).toBe("read-only");
    expect(
      resolveCodeModeContinuationToolPolicy({
        codeModeEngaged: true,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: false },
      }),
    ).toBe("normal");
    expect(
      resolveCodeModeContinuationToolPolicy({
        codeModeEngaged: false,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      }),
    ).toBeNull();
  });

  it("retries an empty stop after a proven side-effect-free Code Mode error", () => {
    const instruction = resolveEmptyResponseRetryInstruction({
      provider: "huggingface",
      modelId: "Qwen/Qwen3.5-9B",
      modelApi: "openai-completions",
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: {
        assistantTexts: [],
        codeModeEngaged: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          content: [],
        },
        lastToolError: { toolName: "exec", error: "module imports are unavailable" },
        toolMetas: [
          {
            toolName: "exec",
            isError: true,
            replaySafe: true,
            sideEffectFree: true,
            codeModeRepairAllowed: true,
          },
          {
            toolName: "exec",
            isError: true,
            replaySafe: true,
            sideEffectFree: true,
            codeModeRepairAllowed: true,
          },
        ],
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      } as never,
    });

    expect(instruction).toContain("failed without side effects");
    expect(instruction).toContain("injected global tools");
  });

  it("retries a settled terminal toolUse after a proven side-effect-free Code Mode error", () => {
    const instruction = resolveEmptyResponseRetryInstruction({
      provider: "huggingface",
      modelId: "Qwen/Qwen3.5-9B",
      modelApi: "openai-completions",
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: {
        assistantTexts: [],
        codeModeEngaged: true,
        currentAttemptAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          content: [],
        },
        lastToolError: { toolName: "exec", error: "text parse failed" },
        toolMetas: [
          {
            toolName: "exec",
            isError: true,
            replaySafe: true,
            sideEffectFree: true,
            codeModeRepairAllowed: true,
          },
        ],
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      } as never,
    });

    expect(instruction).toContain("failed without side effects");
  });

  it("does not retry an empty stop after an unproven Code Mode error", () => {
    const instruction = resolveEmptyResponseRetryInstruction({
      provider: "huggingface",
      modelId: "Qwen/Qwen3.5-9B",
      modelApi: "openai-completions",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: {
        assistantTexts: [],
        codeModeEngaged: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          content: [],
        },
        lastToolError: { toolName: "exec", error: "nested call failed" },
        toolMetas: [{ toolName: "exec", isError: true, replaySafe: false }],
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      } as never,
    });

    expect(instruction).toBeNull();
  });

  it("does not reopen an exhausted side-effect-free Code Mode repair", () => {
    const instruction = resolveEmptyResponseRetryInstruction({
      provider: "huggingface",
      modelId: "Qwen/Qwen3.5-9B",
      modelApi: "openai-completions",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: {
        assistantTexts: [],
        codeModeEngaged: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          content: [],
        },
        lastToolError: { toolName: "exec", error: "corrected code still failed" },
        toolMetas: [
          {
            toolName: "exec",
            isError: true,
            replaySafe: true,
            sideEffectFree: true,
            codeModeRepairAllowed: false,
          },
        ],
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      } as never,
    });

    expect(instruction).toBeNull();
  });

  it("keeps restart-safe restrictions latched across continuation attempts", () => {
    const state = createEmbeddedRunTerminalRetryState();
    state.forceRestartSafeToolsForNextAttempt = true;

    expect(consumeForceRestartSafeToolsForNextAttempt(state, false)).toBe(true);
    expect(consumeForceRestartSafeToolsForNextAttempt(state, false)).toBe(true);
    expect(consumeForceRestartSafeToolsForNextAttempt(state, true)).toBe(true);
  });

  it("keeps terminal read-only tools latched across continuation attempts", () => {
    const state = createEmbeddedRunTerminalRetryState();
    state.forceReadOnlyToolsForNextAttempt = true;

    expect(consumeForceReadOnlyToolsForNextAttempt(state, false)).toBe(true);
    expect(state.forceReadOnlyToolsForNextAttempt).toBe(true);
    expect(consumeForceReadOnlyToolsForNextAttempt(state, false)).toBe(true);
    expect(consumeForceReadOnlyToolsForNextAttempt(state, true)).toBe(true);
  });
});
