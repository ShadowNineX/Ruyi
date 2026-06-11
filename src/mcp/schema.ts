const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "default",
  "definitions",
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
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "number",
  "object",
  "string",
  "null",
]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf"]);
const STRING_SCHEMA_KEYS = new Set([
  "description",
  "format",
  "pattern",
  "title",
]);
const NUMBER_SCHEMA_KEYS = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
]);

type SchemaKeywordHandler = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
) => void;

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

function isJsonSchemaType(value: unknown): value is string {
  return typeof value === "string" && JSON_SCHEMA_TYPES.has(value);
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
    return type.filter(isJsonSchemaType);
  }
  return [];
}

function sanitizeType(value: unknown): string | string[] | undefined {
  if (isJsonSchemaType(value)) return value;
  if (!Array.isArray(value)) return undefined;

  const types = uniqueStrings(value.filter(isJsonSchemaType));
  if (types.length === 0) return undefined;
  return types.length === 1 ? (types[0] ?? "string") : types;
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
  const schemaTypes = getSchemaTypes(schema);
  if (schemaTypes.includes("object")) return true;
  if (schemaTypes.length > 0) return false;

  return isRecord(schema.properties) || "additionalProperties" in schema;
}

function isArraySchema(schema: Record<string, unknown>): boolean {
  const schemaTypes = getSchemaTypes(schema);
  if (schemaTypes.includes("array")) return true;
  if (schemaTypes.length > 0) return false;

  return "items" in schema;
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
    typeof value.minItems === "number" ||
    typeof value.minLength === "number" ||
    typeof value.minProperties === "number" ||
    typeof value.maxItems === "number" ||
    typeof value.maxProperties === "number" ||
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

  if (isRecord(schema.properties) || "additionalProperties" in schema) {
    return "object";
  }
  if ("items" in schema) return "array";
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

function schemaFromUnknown(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    const sanitized = sanitizeSchemaValue(value);
    return isRecord(sanitized) ? sanitized : { type: "string" };
  }

  if (isJsonSchemaType(value)) {
    return { type: value };
  }

  return { type: "string" };
}

function sanitizeProperties(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};

  const properties: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    properties[key] = schemaFromUnknown(childValue);
  }
  return properties;
}

function sanitizeItems(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const [firstItem] = value;
    return firstItem === undefined ? { type: "string" } : schemaFromUnknown(firstItem);
  }

  return schemaFromUnknown(value);
}

function sanitizeSchemaArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map(schemaFromUnknown);
}

function setStringKeyword(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string") {
    target[key] = value;
  }
}

function setNumberKeyword(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

function setTypeKeyword(
  target: Record<string, unknown>,
  _key: string,
  value: unknown,
): void {
  const type = sanitizeType(value);
  if (type !== undefined) target.type = type;
}

function setPropertiesKeyword(
  target: Record<string, unknown>,
  _key: string,
  value: unknown,
): void {
  target.properties = sanitizeProperties(value);
}

function setItemsKeyword(
  target: Record<string, unknown>,
  _key: string,
  value: unknown,
): void {
  target.items = sanitizeItems(value);
}

function setRequiredKeyword(
  target: Record<string, unknown>,
  _key: string,
  value: unknown,
): void {
  target.required = asStringArray(value);
}

function setAdditionalPropertiesKeyword(
  target: Record<string, unknown>,
  _key: string,
  value: unknown,
): void {
  target.additionalProperties =
    typeof value === "boolean" ? value : schemaFromUnknown(value);
}

function setEnumKeyword(
  target: Record<string, unknown>,
  _key: string,
  value: unknown,
): void {
  if (Array.isArray(value)) target.enum = value;
}

function setConstKeyword(
  target: Record<string, unknown>,
  _key: string,
  value: unknown,
): void {
  target.const = value;
}

function setUniqueItemsKeyword(
  target: Record<string, unknown>,
  _key: string,
  value: unknown,
): void {
  if (typeof value === "boolean") target.uniqueItems = value;
}

const KEYWORD_HANDLERS = new Map<string, SchemaKeywordHandler>([
  ["type", setTypeKeyword],
  ["properties", setPropertiesKeyword],
  ["items", setItemsKeyword],
  ["required", setRequiredKeyword],
  ["additionalProperties", setAdditionalPropertiesKeyword],
  ["enum", setEnumKeyword],
  ["const", setConstKeyword],
  ["uniqueItems", setUniqueItemsKeyword],
]);

function setSchemaArrayKeyword(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const schemas = sanitizeSchemaArray(value);
  if (schemas.length > 0) target[key] = schemas;
}

function sanitizeKnownKeyword(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const handler = KEYWORD_HANDLERS.get(key);
  if (handler) {
    handler(target, key, value);
  }
}

function sanitizeSchemaKeyword(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (UNSUPPORTED_SCHEMA_KEYS.has(key)) return;
  if (KEYWORD_HANDLERS.has(key)) {
    sanitizeKnownKeyword(target, key, value);
  } else if (SCHEMA_ARRAY_KEYS.has(key)) {
    setSchemaArrayKeyword(target, key, value);
  } else if (STRING_SCHEMA_KEYS.has(key)) {
    setStringKeyword(target, key, value);
  } else if (NUMBER_SCHEMA_KEYS.has(key)) {
    setNumberKeyword(target, key, value);
  }
}

function sanitizeSchemaKeywords(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    sanitizeSchemaKeyword(sanitized, key, value);
  }
  return sanitized;
}

function normalizeObjectSchema(schema: Record<string, unknown>): void {
  if (!getSchemaTypes(schema).includes("object")) {
    schema.type = "object";
  }
  delete schema.items;
  schema.properties = isRecord(schema.properties) ? schema.properties : {};
  schema.required = asStringArray(schema.required);
  schema.additionalProperties = false;
}

function normalizeArraySchema(schema: Record<string, unknown>): void {
  if (!getSchemaTypes(schema).includes("array")) {
    schema.type = "array";
  }
  delete schema.properties;
  delete schema.required;
  delete schema.additionalProperties;
  if (!isRecord(schema.items)) {
    schema.items = { type: "string" };
  }
}

function normalizeScalarSchema(schema: Record<string, unknown>): void {
  delete schema.properties;
  delete schema.required;
  delete schema.additionalProperties;
  delete schema.items;
}

function normalizeSchemaShape(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (isSchemaLike(schema)) schema.type = inferSchemaType(schema);
  if (isObjectSchema(schema)) normalizeObjectSchema(schema);
  if (isArraySchema(schema)) normalizeArraySchema(schema);
  if (!isObjectSchema(schema) && !isArraySchema(schema)) {
    normalizeScalarSchema(schema);
  }
  return schema;
}

function sanitizeSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchemaValue);
  if (!isRecord(value)) return value;
  return normalizeSchemaShape(sanitizeSchemaKeywords(value));
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
