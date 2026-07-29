/**
 * Repairs small-model calls that either copy a Code Mode guest method into the
 * outer provider channel or put one guest method's arguments directly in `exec`.
 */
import type { Tool, ToolCall } from "@openclaw/ai";
import { validateToolArguments } from "@openclaw/ai/validation";
import { visitObjectContentBlocks } from "../../../shared/message-content-blocks.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
} from "../../code-mode-control-tools.js";
import type { StreamFn } from "../../runtime/index.js";
import { isRunnerToolCallBlockType } from "./attempt.tool-call-block-type.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";

const MAX_TRANSLATED_ARGUMENT_CHARS = 64_000;
const GUEST_TOOL_PREFIX_PATTERN = /^tools[./]([A-Za-z_$][A-Za-z0-9_$]*)$/u;

type AssistantStream = Awaited<ReturnType<StreamFn>>;
type GuestToolInvocation = {
  arguments: unknown;
  name: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveGuestToolName(
  rawName: string,
  guestToolNames: ReadonlySet<string>,
): string | undefined {
  const trimmed = rawName.trim();
  if (trimmed === CODE_MODE_EXEC_TOOL_NAME || trimmed === CODE_MODE_WAIT_TOOL_NAME) {
    return undefined;
  }
  const prefixed = GUEST_TOOL_PREFIX_PATTERN.exec(trimmed)?.[1];
  const candidate = prefixed ?? trimmed;
  return guestToolNames.has(candidate) ? candidate : undefined;
}

function serializeGuestToolArguments(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= MAX_TRANSLATED_ARGUMENT_CHARS ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function resolveUniqueGuestToolByArguments(
  rawArguments: Record<string, unknown>,
  guestToolSchemas: ReadonlyMap<string, unknown>,
): GuestToolInvocation | undefined {
  // This runs before outer tool validation or nested dispatch. Ambiguous schema
  // matches keep the original invalid exec call so OpenClaw still fails closed.
  const argumentKeys = Object.keys(rawArguments);
  if (argumentKeys.length === 0) {
    return undefined;
  }
  let matched: GuestToolInvocation | undefined;
  for (const [name, parameters] of guestToolSchemas) {
    const properties =
      isRecord(parameters) && isRecord(parameters.properties) ? parameters.properties : undefined;
    // Open schemas often accept arbitrary extra keys. Requiring every supplied
    // key to be declared prevents a no-argument tool from becoming a false match.
    if (!properties || !argumentKeys.every((key) => Object.hasOwn(properties, key))) {
      continue;
    }
    try {
      const validated = validateToolArguments({ name, description: "", parameters } as Tool, {
        type: "toolCall",
        id: "code-mode-outer-call-repair",
        name,
        arguments: rawArguments,
      } satisfies ToolCall);
      if (matched) {
        return undefined;
      }
      matched = { name, arguments: validated };
    } catch {
      // Non-matching schemas are expected; only one exact match is repairable.
    }
  }
  return matched;
}

function resolveGuestToolInvocation(
  rawName: string,
  rawArguments: unknown,
  guestToolNames: ReadonlySet<string>,
  guestToolSchemas: ReadonlyMap<string, unknown>,
): GuestToolInvocation | undefined {
  const guestToolName = resolveGuestToolName(rawName, guestToolNames);
  if (guestToolName) {
    return { name: guestToolName, arguments: rawArguments };
  }
  if (
    rawName.trim() !== CODE_MODE_EXEC_TOOL_NAME ||
    !isRecord(rawArguments) ||
    Object.hasOwn(rawArguments, "code") ||
    Object.hasOwn(rawArguments, "command") ||
    Object.hasOwn(rawArguments, "language") ||
    Object.hasOwn(rawArguments, "restartSafe")
  ) {
    return undefined;
  }
  return resolveUniqueGuestToolByArguments(rawArguments, guestToolSchemas);
}

function translateCodeModeGuestToolCall(
  block: unknown,
  guestToolNames: ReadonlySet<string>,
  guestToolSchemas: ReadonlyMap<string, unknown>,
): void {
  if (!block || typeof block !== "object") {
    return;
  }
  const toolCall = block as {
    type?: unknown;
    name?: unknown;
    arguments?: unknown;
    input?: unknown;
  };
  if (!isRunnerToolCallBlockType(toolCall.type) || typeof toolCall.name !== "string") {
    return;
  }
  const rawArguments = toolCall.arguments ?? toolCall.input;
  const invocation = resolveGuestToolInvocation(
    toolCall.name,
    rawArguments,
    guestToolNames,
    guestToolSchemas,
  );
  if (!invocation) {
    return;
  }
  const serializedArguments = serializeGuestToolArguments(invocation.arguments);
  if (!serializedArguments) {
    return;
  }
  const translatedArguments = {
    code: `return await tools[${JSON.stringify(invocation.name)}](JSON.parse(${JSON.stringify(serializedArguments)}));`,
  };
  toolCall.name = "exec";
  toolCall.arguments = translatedArguments;
  if ("input" in toolCall) {
    toolCall.input = translatedArguments;
  }
  if (typeof (toolCall as { partialArgs?: unknown }).partialArgs === "string") {
    (toolCall as { partialArgs: string }).partialArgs = JSON.stringify(translatedArguments);
  }
}

function translateCodeModeGuestToolCalls(
  message: unknown,
  guestToolNames: ReadonlySet<string>,
  guestToolSchemas: ReadonlyMap<string, unknown>,
): void {
  visitObjectContentBlocks(message, (block) => {
    translateCodeModeGuestToolCall(block, guestToolNames, guestToolSchemas);
  });
}

function wrapStreamTranslateCodeModeGuestToolCalls(
  stream: AssistantStream,
  guestToolNames: ReadonlySet<string>,
  guestToolSchemas: ReadonlyMap<string, unknown>,
): AssistantStream {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    translateCodeModeGuestToolCalls(message, guestToolNames, guestToolSchemas);
    return message;
  };
  wrapStreamObjectEvents(stream, (event) => {
    if (event.type === "done") {
      translateCodeModeGuestToolCalls(event.partial, guestToolNames, guestToolSchemas);
      translateCodeModeGuestToolCalls(event.message, guestToolNames, guestToolSchemas);
      return;
    }
    if (event.type !== "toolcall_end") {
      return;
    }
    translateCodeModeGuestToolCall(event.toolCall, guestToolNames, guestToolSchemas);
    // Transports project the canonical assistant blocks through different event
    // fields. Keep every populated view aligned before dispatch or persistence.
    translateCodeModeGuestToolCalls(event.partial, guestToolNames, guestToolSchemas);
    translateCodeModeGuestToolCalls(event.message, guestToolNames, guestToolSchemas);
  });
  return stream;
}

export function wrapStreamFnTranslateCodeModeGuestToolCalls(
  baseFn: StreamFn,
  guestToolNames?: ReadonlySet<string>,
  guestToolSchemas?: ReadonlyMap<string, unknown>,
): StreamFn {
  if (!guestToolNames || guestToolNames.size === 0) {
    return baseFn;
  }
  const schemas = guestToolSchemas ?? new Map();
  return (model, context, streamOptions) => {
    const maybeStream = baseFn(model, context, streamOptions);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamTranslateCodeModeGuestToolCalls(stream, guestToolNames, schemas),
      );
    }
    return wrapStreamTranslateCodeModeGuestToolCalls(maybeStream, guestToolNames, schemas);
  };
}
