import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";

function schemaAcceptsValue(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  try {
    return Value.Check(schema as never, value);
  } catch {
    return false;
  }
}

function readComposedSchemaBranches(schema: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf;
  }
  return Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
}

export function repairCodeModeToolInput(schema: unknown, value: unknown, depth = 0): unknown {
  if (!isRecord(schema) || depth > 6) {
    return value;
  }
  if (schemaAcceptsValue(schema, value)) {
    return value;
  }
  const composedBranches = readComposedSchemaBranches(schema);
  if (composedBranches?.length) {
    for (const branch of composedBranches) {
      const repaired = repairCodeModeToolInput(branch, value, depth + 1);
      if (repaired !== value && schemaAcceptsValue(schema, repaired)) {
        return repaired;
      }
    }
    return value;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (typeof value === "string") {
    if (types.includes("string")) {
      return value;
    }
    if (types.includes("number") || types.includes("integer")) {
      const trimmed = value.trim();
      if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
        const parsed = Number(trimmed);
        const typeAcceptsParsed =
          types.includes("number") || (types.includes("integer") && Number.isSafeInteger(parsed));
        if (Number.isFinite(parsed) && typeAcceptsParsed && schemaAcceptsValue(schema, parsed)) {
          return parsed;
        }
      }
    }
    if (types.includes("boolean") && (value === "true" || value === "false")) {
      const parsed = value === "true";
      return schemaAcceptsValue(schema, parsed) ? parsed : value;
    }
    if (types.includes("array") || types.includes("object")) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (
          (types.includes("array") && Array.isArray(parsed)) ||
          (types.includes("object") && isRecord(parsed))
        ) {
          const repaired = repairCodeModeToolInput(schema, parsed, depth + 1);
          return schemaAcceptsValue(schema, repaired) ? repaired : value;
        }
      } catch {
        // Only complete JSON containers are repaired.
      }
    }
    return value;
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    let changed = false;
    const repaired = value.map((entry) => {
      const next = repairCodeModeToolInput(schema.items, entry, depth + 1);
      changed ||= next !== entry;
      return next;
    });
    return changed && schemaAcceptsValue(schema, repaired) ? repaired : value;
  }
  if (!isRecord(value) || !isRecord(schema.properties)) {
    return value;
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  const repaired = Object.create(null) as Record<string, unknown>;
  let changed = false;
  for (const [key, current] of Object.entries(value)) {
    const propertySchema = schema.properties[key];
    if (
      current === null &&
      propertySchema !== undefined &&
      !required.has(key) &&
      !schemaAcceptsValue(propertySchema, null)
    ) {
      changed = true;
      continue;
    }
    const next =
      propertySchema === undefined
        ? current
        : repairCodeModeToolInput(propertySchema, current, depth + 1);
    changed ||= next !== current;
    Object.defineProperty(repaired, key, {
      configurable: true,
      enumerable: true,
      value: next,
      writable: true,
    });
  }
  return changed && schemaAcceptsValue(schema, repaired) ? repaired : value;
}
