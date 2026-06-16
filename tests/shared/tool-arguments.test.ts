import { describe, expect, test } from "bun:test";
import {
  argumentEntriesToRecord,
  formatToolArgumentLines,
  formatToolArgumentsMarkdown,
  parseNullableToolArguments,
  parseToolArguments,
} from "../../src/utils/tool-arguments";

describe("tool argument parsing", () => {
  test("parses object arguments directly", () => {
    expect(parseToolArguments({ target: "bot", count: 2 })).toEqual({
      target: "bot",
      count: 2,
    });
  });

  test("parses JSON string arguments", () => {
    expect(parseToolArguments('{"target":"owner","message":"hello"}')).toEqual({
      target: "owner",
      message: "hello",
    });
  });

  test("returns empty arguments for invalid or non-record input", () => {
    expect(parseToolArguments("[1,2,3]")).toEqual({});
    expect(parseToolArguments("not json")).toEqual({});
    expect(parseToolArguments(123)).toEqual({});
  });

  test("preserves nullable argument distinction", () => {
    expect(parseNullableToolArguments(null)).toBeNull();
    expect(parseNullableToolArguments(undefined)).toBeNull();
    expect(parseNullableToolArguments('{"ok":true}')).toEqual({ ok: true });
  });

  test("converts Smithery-style argument entries into records", () => {
    const record = argumentEntriesToRecord([
      { name: "query", value: "tails" },
      { name: "filters", json_value: '{"safe":true,"limit":3}' },
      { name: "", value: "ignored" },
      { value: "ignored" },
    ]);

    expect(record).toEqual({
      query: "tails",
      filters: { safe: true, limit: 3 },
    });
  });
});

describe("tool argument formatting", () => {
  test("formats meaningful arguments as readable markdown lines", () => {
    expect(
      formatToolArgumentLines({
        target: "bot",
        empty: "",
        items: ["one", "two"],
        nested: { a: 1, b: "two" },
      }),
    ).toEqual([
      "- `target`: bot",
      "- `items`: one, two",
      "- `nested`: a: 1; b: two",
    ]);
  });

  test("limits displayed argument lines", () => {
    expect(
      formatToolArgumentLines(
        { a: 1, b: 2, c: 3 },
        { lineLimit: 2 },
      ),
    ).toEqual(["- `a`: 1", "- `b`: 2", "- ...and 1 more"]);
  });

  test("returns null markdown when there is nothing useful to show", () => {
    expect(formatToolArgumentsMarkdown({ empty: "", none: null })).toBeNull();
  });
});
