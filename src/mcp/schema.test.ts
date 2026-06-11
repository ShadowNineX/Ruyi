import { describe, expect, test } from "bun:test";
import { sanitizeMcpInputSchema } from "./schema";

describe("sanitizeMcpInputSchema", () => {
  test("normalizes shorthand property schemas and strips unsupported keywords", () => {
    const sanitized = sanitizeMcpInputSchema({
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {
        title: "string",
        labels: {
          type: "array",
          items: "string",
          prefixItems: [{ type: "number" }],
        },
        issue: {
          type: "integer",
          properties: {
            bogus: { type: "string" },
          },
        },
      },
      required: ["title", 42, "labels"],
      additionalProperties: { type: "string" },
    } as Record<string, unknown>);

    expect(sanitized).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        labels: {
          type: "array",
          items: { type: "string" },
        },
        issue: { type: "integer" },
      },
      required: ["title", "labels"],
      additionalProperties: false,
    });
  });

  test("keeps valid composition schemas while making each branch object-shaped", () => {
    const sanitized = sanitizeMcpInputSchema({
      properties: {
        body: {
          anyOf: ["string", { type: "null" }],
        },
      },
    } as Record<string, unknown>);

    expect(sanitized).toEqual({
      type: "object",
      properties: {
        body: {
          type: ["string", "null"],
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
      required: [],
      additionalProperties: false,
    });
  });
});
