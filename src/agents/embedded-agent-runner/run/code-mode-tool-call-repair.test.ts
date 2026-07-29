import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt.tool-call-normalization.js";
import { wrapStreamFnTranslateCodeModeGuestToolCalls } from "./code-mode-tool-call-repair.js";

const GUEST_TOOL_SCHEMAS = new Map<string, unknown>([
  ["read", Type.Object({ path: Type.String() }, { additionalProperties: false })],
  [
    "write",
    Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }),
  ],
  ["status", Type.Object({}, { additionalProperties: true })],
  ["run", Type.Object({ command: Type.String() }, { additionalProperties: false })],
]);

function createFakeStream(params: { events?: unknown[]; resultMessage: unknown }) {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events ?? []) {
          yield event;
        }
      })();
    },
  };
}

async function invoke(params: { events?: unknown[]; resultMessage: unknown }) {
  const baseFn = vi.fn(() => createFakeStream(params));
  const wrapped = wrapStreamFnTranslateCodeModeGuestToolCalls(
    baseFn as never,
    new Set(GUEST_TOOL_SCHEMAS.keys()),
    GUEST_TOOL_SCHEMAS,
  );
  const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
  for await (const event of stream) {
    void event;
  }
  return await stream.result();
}

describe("Code Mode outer guest tool-call repair", () => {
  it.each(["read", "tools.read", "tools/read"])(
    "translates exact guest method %s into exec",
    async (name) => {
      const message = {
        role: "assistant",
        content: [{ type: "toolCall", name, arguments: { path: "facts.txt" } }],
      };

      await expect(invoke({ resultMessage: message })).resolves.toEqual({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "exec",
            arguments: {
              code: 'return await tools["read"](JSON.parse("{\\"path\\":\\"facts.txt\\"}"));',
            },
          },
        ],
      });
    },
  );

  it("waits for tool-call completion before translating streamed projections", async () => {
    const partialCall = {
      type: "toolCall",
      name: "tools.write",
      arguments: {},
    };
    const streamedCall = {
      type: "toolCall",
      name: "tools.write",
      arguments: { path: "result.txt", content: "ok" },
    };
    const endMessageCall = structuredClone(streamedCall);
    const eventMessageCall = structuredClone(streamedCall);
    const finalCall = structuredClone(streamedCall);
    await invoke({
      events: [
        { type: "toolcall_delta", partial: { content: [partialCall] } },
        {
          type: "toolcall_end",
          toolCall: streamedCall,
          partial: { content: [endMessageCall] },
          message: { role: "assistant", content: [eventMessageCall] },
        },
      ],
      resultMessage: { role: "assistant", content: [finalCall] },
    });

    expect(partialCall).toEqual({
      type: "toolCall",
      name: "tools.write",
      arguments: {},
    });
    const translated = {
      type: "toolCall",
      name: "exec",
      arguments: {
        code: 'return await tools["write"](JSON.parse("{\\"path\\":\\"result.txt\\",\\"content\\":\\"ok\\"}"));',
      },
    };
    expect(streamedCall).toEqual(translated);
    expect(endMessageCall).toEqual(translated);
    expect(eventMessageCall).toEqual(translated);
    expect(finalCall).toEqual(translated);
  });

  it("translates malformed exec arguments when exactly one guest schema matches", async () => {
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", name: "exec", arguments: { path: "facts.txt" } }],
    };

    await expect(invoke({ resultMessage: message })).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "exec",
          arguments: {
            code: 'return await tools["read"](JSON.parse("{\\"path\\":\\"facts.txt\\"}"));',
          },
        },
      ],
    });
  });

  it("promotes truncated guest XML and translates every terminal projection to exec", async () => {
    const rawToolText = [
      "<function=tools.read>",
      "<parameter=path>",
      "facts.txt",
      "</parameter>",
    ].join("\n");
    const resultMessage = {
      role: "assistant",
      content: [{ type: "text", text: rawToolText }],
      stopReason: "stop",
    };
    const doneMessage = structuredClone(resultMessage);
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          { type: "text_delta", contentIndex: 0, delta: rawToolText },
          { type: "done", reason: "stop", message: doneMessage },
        ],
        resultMessage,
      }),
    );
    const promoted = wrapStreamFnPromoteStandaloneTextToolCalls(
      baseFn as never,
      new Set(["exec"]),
      {
        additionalAllowedToolNames: new Set(["tools.read"]),
        allowMissingXmlFunctionClose: true,
      },
    );
    const wrapped = wrapStreamFnTranslateCodeModeGuestToolCalls(
      promoted,
      new Set(GUEST_TOOL_SCHEMAS.keys()),
      GUEST_TOOL_SCHEMAS,
    );
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();
    const expectedArguments = {
      code: 'return await tools["read"](JSON.parse("{\\"path\\":\\"facts.txt\\"}"));',
    };

    expect(result).toMatchObject({
      content: [{ type: "toolCall", name: "exec", arguments: expectedArguments }],
      stopReason: "toolUse",
    });
    const toolCallEnd = events.find(
      (event) => (event as { type?: unknown }).type === "toolcall_end",
    ) as { toolCall?: unknown };
    expect(toolCallEnd.toolCall).toMatchObject({
      name: "exec",
      arguments: expectedArguments,
    });
    const doneEvent = events.find((event) => (event as { type?: unknown }).type === "done") as {
      message?: { content?: unknown[] };
    };
    expect(doneEvent.message?.content?.[0]).toMatchObject({
      name: "exec",
      arguments: expectedArguments,
    });
    expect(JSON.stringify({ events, result })).not.toContain(rawToolText);
  });

  it("translates after provider argument repair reconstructs streamed exec arguments", async () => {
    const partialCall = {
      type: "toolCall",
      name: "exec",
      arguments: {},
      partialArgs: "",
    };
    const streamedCall = structuredClone(partialCall);
    const finalCall = structuredClone(partialCall);
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"facts.txt"}',
            partial: { content: [partialCall] },
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedCall,
            partial: { content: [partialCall] },
          },
        ],
        resultMessage: { role: "assistant", content: [finalCall] },
      }),
    );
    const repaired = wrapStreamFnRepairMalformedToolCallArguments(baseFn as never);
    const wrapped = wrapStreamFnTranslateCodeModeGuestToolCalls(
      repaired,
      new Set(["read", "write"]),
      GUEST_TOOL_SCHEMAS,
    );
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));

    for await (const event of stream) {
      void event;
    }
    const result = await stream.result();
    const expectedArguments = {
      code: 'return await tools["read"](JSON.parse("{\\"path\\":\\"facts.txt\\"}"));',
    };
    expect(streamedCall).toMatchObject({
      name: "exec",
      arguments: expectedArguments,
      partialArgs: JSON.stringify(expectedArguments),
    });
    expect(partialCall).toMatchObject({
      name: "exec",
      arguments: expectedArguments,
      partialArgs: JSON.stringify(expectedArguments),
    });
    expect(result).toMatchObject({
      content: [
        {
          name: "exec",
          arguments: expectedArguments,
          partialArgs: JSON.stringify(expectedArguments),
        },
      ],
    });
  });

  it("leaves malformed exec arguments unchanged when guest schemas are ambiguous", async () => {
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", name: "exec", arguments: { path: "facts.txt" } }],
    };
    const baseFn = vi.fn(() => createFakeStream({ resultMessage: message }));
    const ambiguousSchemas = new Map(GUEST_TOOL_SCHEMAS);
    ambiguousSchemas.set(
      "inspect",
      Type.Object({ path: Type.String() }, { additionalProperties: false }),
    );
    const wrapped = wrapStreamFnTranslateCodeModeGuestToolCalls(
      baseFn as never,
      new Set(["read", "write", "status", "inspect"]),
      ambiguousSchemas,
    );
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));

    await expect(stream.result()).resolves.toBe(message);
    expect(message.content[0]?.arguments).toEqual({ path: "facts.txt" });
  });

  it("never translates the outer Code Mode controls", async () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "exec",
          arguments: { code: 'return await tools["read"]({"path":"facts.txt"});' },
        },
      ],
    };
    const baseFn = vi.fn(() => createFakeStream({ resultMessage: message }));
    const wrapped = wrapStreamFnTranslateCodeModeGuestToolCalls(
      baseFn as never,
      new Set(["read", "exec"]),
      GUEST_TOOL_SCHEMAS,
    );
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));

    await expect(stream.result()).resolves.toBe(message);
    expect(message.content[0]?.arguments).toEqual({
      code: 'return await tools["read"]({"path":"facts.txt"});',
    });
  });

  it("preserves own __proto__ keys as JSON data", async () => {
    const argumentsWithProto = JSON.parse(
      '{"__proto__":{"safe":true},"nested":{"__proto__":"value"}}',
    );
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: argumentsWithProto }],
    };

    const result = await invoke({ resultMessage: message });
    const code = (result as { content: Array<{ arguments: { code: string } }> }).content[0]
      ?.arguments.code;

    expect(code).toBe(
      'return await tools["read"](JSON.parse("{\\"__proto__\\":{\\"safe\\":true},\\"nested\\":{\\"__proto__\\":\\"value\\"}}"));',
    );
  });

  it.each([
    { name: "tools.unknown", arguments: {} },
    { name: "tools.read.extra", arguments: {} },
    { name: "read", arguments: "fragment" },
    { name: "exec", arguments: {} },
    { name: "exec", arguments: { code: "return 1;" } },
    { name: "exec", arguments: { command: "return 1;" } },
    { name: "exec", arguments: { language: "javascript", path: "facts.txt" } },
  ])("leaves unsupported calls unchanged: $name", async (toolCall) => {
    const message = { role: "assistant", content: [{ type: "toolCall", ...toolCall }] };
    const expected = structuredClone(message);

    await expect(invoke({ resultMessage: message })).resolves.toEqual(expected);
  });
});
