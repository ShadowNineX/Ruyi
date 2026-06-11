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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function typeFromConst(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const valueType = typeof value;
  if (
    valueType === "string" ||
    valueType === "number" ||
    valueType === "boolean"
  ) {
    return valueType;
  }
  return "object";
}

function getSchemaTypes(schema: Record<string, unknown>): string[] {
  const type = schema.type;
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) {
    return type.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function schemaArrayTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return uniqueStrings(
    value.flatMap((item) => (isRecord(item) ? getSchemaTypes(item) : [])),
  );
}

function enumTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map(typeFromConst));
}

function isObjectSchema(schema: Record<string, unknown>): boolean {
  return getSchemaTypes(schema).includes("object") || isRecord(schema.properties);
}

function isArraySchema(schema: Record<string, unknown>): boolean {
  return getSchemaTypes(schema).includes("array") || isRecord(schema.items);
}

function isSchemaLike(value: Record<string, unknown>): boolean {
  return (
    "type" in value ||
    "properties" in value ||
    "items" in value ||
    "anyOf" in value ||
    "oneOf" in value ||
    "allOf" in value ||
    "enum" in value ||
    "const" in value ||
    "additionalProperties" in value ||
    "required" in value ||
    typeof value.description === "string" ||
    typeof value.format === "string" ||
    typeof value.pattern === "string" ||
    typeof value.minimum === "number" ||
    typeof value.maximum === "number" ||
    typeof value.minLength === "number" ||
    typeof value.maxLength === "number"
  );
}

function inferSchemaType(schema: Record<string, unknown>): string | string[] {
  const existingTypes = getSchemaTypes(schema);
  if (existingTypes.length > 0) {
    return existingTypes.length === 1 ? (existingTypes[0] ?? "string") : existingTypes;
  }

  if ("const" in schema) return typeFromConst(schema.const);

  const enumTypeValues = enumTypes(schema.enum);
  if (enumTypeValues.length > 0) {
    return enumTypeValues.length === 1 ? (enumTypeValues[0] ?? "string") : enumTypeValues;
  }

  const unionTypes = uniqueStrings([
    ...schemaArrayTypes(schema.anyOf),
    ...schemaArrayTypes(schema.oneOf),
    ...schemaArrayTypes(schema.allOf),
  ]);
  if (unionTypes.length > 0) {
    return unionTypes.length === 1 ? (unionTypes[0] ?? "string") : unionTypes;
  }

  if (isRecord(schema.properties)) return "object";
  if (isRecord(schema.items) || Array.isArray(schema.items)) return "array";
  if (
    typeof schema.minimum === "number" ||
    typeof schema.maximum === "number" ||
    typeof schema.exclusiveMinimum === "number" ||
    typeof schema.exclusiveMaximum === "number" ||
    typeof schema.multipleOf === "number"
  ) {
    return "number";
  }
  if (
    typeof schema.pattern === "string" ||
    typeof schema.format === "string" ||
    typeof schema.minLength === "number" ||
    typeof schema.maxLength === "number"
  ) {
    return "string";
  }

  return "string";
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

  if (isSchemaLike(sanitized)) {
    sanitized.type = inferSchemaType(sanitized);
  }

  if (isObjectSchema(sanitized)) {
    if (!getSchemaTypes(sanitized).includes("object")) {
      sanitized.type = "object";
    }
    sanitized.properties = isRecord(sanitized.properties)
      ? sanitized.properties
      : {};
    sanitized.required = asStringArray(sanitized.required);
    sanitized.additionalProperties = false;
  }

  if (isArraySchema(sanitized) && !isRecord(sanitized.items)) {
    sanitized.items = { type: "string" };
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
