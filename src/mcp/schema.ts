const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$id",
  "$schema",
  "default",
  "dependentRequired",
  "dependentSchemas",
  "deprecated",
  "examples",
  "if",
  "then",
  "else",
  "not",
  "patternProperties",
  "propertyNames",
  "readOnly",
  "unevaluatedItems",
  "unevaluatedProperties",
  "writeOnly",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isObjectSchema(schema: Record<string, unknown>): boolean {
  return schema.type === "object" || isRecord(schema.properties);
}

function sanitizeSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeSchemaValue);
  }

  if (!isRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    sanitized[key] = sanitizeSchemaValue(childValue);
  }

  if (isObjectSchema(sanitized)) {
    sanitized.type = "object";
    sanitized.properties = isRecord(sanitized.properties)
      ? sanitized.properties
      : {};
    sanitized.required = asStringArray(sanitized.required);
    sanitized.additionalProperties = false;
  }

  return sanitized;
}

export function sanitizeMcpInputSchema<TSchema extends Record<string, unknown>>(
  schema: TSchema,
): TSchema {
  const sanitized = sanitizeSchemaValue(schema);
  if (!isRecord(sanitized)) {
    return {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    } as unknown as TSchema;
  }

  sanitized.type = "object";
  sanitized.properties = isRecord(sanitized.properties)
    ? sanitized.properties
    : {};
  sanitized.required = asStringArray(sanitized.required);
  sanitized.additionalProperties = false;

  return sanitized as TSchema;
}
