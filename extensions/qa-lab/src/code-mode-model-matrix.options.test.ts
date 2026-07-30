import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodeModeMatrixAgentEnv,
  buildCodeModeMatrixConfig,
  modelCellPrefix,
  parseCodeModeMatrixOptions,
  reserveCodeModeMatrixOutputDir,
  resolveCodeModeMatrixCellRuntimePaths,
  resolveCodeModeMatrixOutputDir,
} from "../../../scripts/code-mode-model-matrix.ts";

describe("Code Mode model matrix options", () => {
  it("defaults to the complete bounded matrix", () => {
    expect(parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:9b"], "/repo")).toMatchObject({
      models: ["ollama/qwen3.5:9b"],
      modes: ["direct", "auto", "code"],
      agentRuntime: "openclaw",
      localModelLean: true,
      tasks: ["read", "read-two-files", "dependent-read-write", "edit-readback"],
      repetitions: 3,
      seed: undefined,
      temperature: undefined,
      timeoutSeconds: 180,
      thinking: "off",
      repoRoot: "/repo",
    });
  });

  it("parses explicit sampling controls and rejects invalid values", () => {
    expect(
      parseCodeModeMatrixOptions(
        ["--model", "ollama/qwen3.5:4b", "--temperature", "0", "--seed", "42"],
        "/repo",
      ),
    ).toMatchObject({ temperature: 0, seed: 42 });
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:4b", "--temperature", "nope"]),
    ).toThrow("non-negative finite number");
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:4b", "--seed", "1.5"]),
    ).toThrow("non-negative integer");
  });

  it("resolves a separate product checkout for frozen comparisons", () => {
    expect(
      parseCodeModeMatrixOptions(
        ["--model", "openai/gpt-5.6-sol", "--target-root", "../baseline"],
        "/repo/harness",
      ),
    ).toMatchObject({
      repoRoot: "/repo/harness",
      targetRoot: "/repo/baseline",
    });
  });

  it("rejects ambiguous selectors and output paths", () => {
    expect(() => parseCodeModeMatrixOptions([])).toThrow("At least one --model");
    expect(() => parseCodeModeMatrixOptions(["--model", "qwen3.5:9b"])).toThrow("provider/model");
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:9b", "--skip-build"]),
    ).toThrow("Unknown argument");
    expect(() =>
      parseCodeModeMatrixOptions([
        "--model",
        "ollama/qwen3.5:9b",
        "--mode",
        "code",
        "--mode",
        "code",
      ]),
    ).toThrow("Duplicate --mode");
    expect(() =>
      resolveCodeModeMatrixOutputDir("/repo", "../outside", new Date("2026-07-28T12:00:00Z")),
    ).toThrow("within the repository");
    expect(() =>
      resolveCodeModeMatrixOutputDir("/repo", "/tmp/out", new Date("2026-07-28T12:00:00Z")),
    ).toThrow("repo-relative");
    expect(() =>
      resolveCodeModeMatrixOutputDir("/repo", ".", new Date("2026-07-28T12:00:00Z")),
    ).toThrow("within the repository");
  });

  it("reserves a fresh output path without symlink traversal", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-output-test-"));
    try {
      const existing = path.join(repoRoot, "existing");
      await fs.mkdir(existing);
      await expect(reserveCodeModeMatrixOutputDir(repoRoot, existing)).rejects.toThrow(
        "must not already exist",
      );

      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-outside-test-"));
      const linked = path.join(repoRoot, "linked");
      await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
      await expect(
        reserveCodeModeMatrixOutputDir(repoRoot, path.join(linked, "results")),
      ).rejects.toThrow("must not traverse symlinks");
      await fs.rm(outside, { force: true, recursive: true });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("allows only one concurrent run to reserve an output path", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-reserve-test-"));
    try {
      const outputDir = path.join(repoRoot, "nested", "results");
      const attempts = await Promise.allSettled([
        reserveCodeModeMatrixOutputDir(repoRoot, outputDir),
        reserveCodeModeMatrixOutputDir(repoRoot, outputDir),
      ]);

      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("must not already exist"),
        }),
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });
});

describe("Code Mode model matrix provider setup", () => {
  it("adds the documented non-secret marker only for local Ollama runs", () => {
    expect(
      buildCodeModeMatrixAgentEnv("ollama/qwen3.5:9b", "/runtime", "/state", {}),
    ).toMatchObject({
      NODE_DISABLE_COMPILE_CACHE: "1",
      OLLAMA_API_KEY: "ollama-local",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join("/runtime", "dist", "extensions"),
      OPENCLAW_CONFIG_PATH: path.join("/state", "openclaw.json"),
      OPENCLAW_STATE_DIR: "/state",
    });
    expect(
      buildCodeModeMatrixAgentEnv("ollama/qwen3.5:9b", "/runtime", "/state", {
        OLLAMA_API_KEY: "configured-value",
      }).OLLAMA_API_KEY,
    ).toBe("configured-value");
    expect(
      buildCodeModeMatrixAgentEnv("huggingface/model", "/runtime", "/state", {}).OLLAMA_API_KEY,
    ).toBeUndefined();
    expect(
      buildCodeModeMatrixAgentEnv(
        "huggingface/model",
        "/runtime",
        "/state",
        {},
        {
          configPath: "/runtime/config/cell.json",
          credentialAgentDir: "/home/user/.openclaw/agents/main/agent",
        },
      ),
    ).toMatchObject({
      OPENCLAW_AGENT_DIR: "/home/user/.openclaw/agents/main/agent",
      OPENCLAW_CONFIG_PATH: "/runtime/config/cell.json",
      OPENCLAW_STATE_DIR: "/state",
    });
  });

  it("pins runtime and sampling controls through supported model config", () => {
    expect(buildCodeModeMatrixConfig("openai/gpt-5.6-sol")).toEqual({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
    });
    expect(buildCodeModeMatrixConfig("openai/gpt-5.6-sol", "default")).toEqual({});
    expect(
      buildCodeModeMatrixConfig(
        "openai/gpt-5.6-sol",
        "default",
        {},
        {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-sol": {
                  agentRuntime: { id: "openclaw" },
                  params: { maxTokens: 512 },
                },
              },
            },
          },
        },
      ),
    ).toEqual({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": {
              params: { maxTokens: 512 },
            },
          },
        },
      },
    });
    expect(
      buildCodeModeMatrixConfig(
        "huggingface/qwen",
        "openclaw",
        { temperature: 0 },
        {
          models: {
            providers: {
              huggingface: {
                baseUrl: "https://router.huggingface.co/v1",
                api: "openai-completions",
                models: [{ id: "qwen", name: "Qwen" }],
              },
            },
          },
          agents: {
            defaults: {
              models: {
                "huggingface/qwen": {
                  params: { maxTokens: 512 },
                },
              },
            },
          },
        },
      ),
    ).toMatchObject({
      models: {
        providers: {
          huggingface: {
            baseUrl: "https://router.huggingface.co/v1",
          },
        },
      },
      agents: {
        defaults: {
          models: {
            "huggingface/qwen": {
              agentRuntime: { id: "openclaw" },
              params: { maxTokens: 512, temperature: 0 },
            },
          },
        },
      },
    });
    expect(
      buildCodeModeMatrixConfig("ollama/qwen3.5:4b", "openclaw", {
        seed: 42,
        temperature: 0,
      }),
    ).toEqual({
      agents: {
        defaults: {
          models: {
            "ollama/qwen3.5:4b": {
              agentRuntime: { id: "openclaw" },
              params: { seed: 42, temperature: 0 },
            },
          },
        },
      },
    });
  });
});

describe("Code Mode model matrix identity", () => {
  it("keeps punctuation variants distinct", () => {
    expect(modelCellPrefix("ollama/foo.bar")).not.toBe(modelCellPrefix("ollama/foo-bar"));
  });

  it("retains a distinct workspace for every repetition", () => {
    const first = resolveCodeModeMatrixCellRuntimePaths("/run", "ollama-qwen-code-read-1");
    const second = resolveCodeModeMatrixCellRuntimePaths("/run", "ollama-qwen-code-read-2");

    expect(first.workspace).toBe(path.join("/run", "workspaces", "ollama-qwen-code-read-1"));
    expect(second.workspace).toBe(path.join("/run", "workspaces", "ollama-qwen-code-read-2"));
    expect(first.workspace).not.toBe(second.workspace);
  });
});
