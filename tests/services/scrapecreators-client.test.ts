import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  hasScrapeCreatorsApiKey,
  parseScrapeCreatorsSchema,
  ScrapeCreatorsApiError,
} from "../../src/services/scrapecreators-client";

describe("ScrapeCreators client helpers", () => {
  test("reports missing API key in test env", () => {
    expect(hasScrapeCreatorsApiKey()).toBe(false);
  });

  test("parses documented response shapes with zod", () => {
    const schema = z.object({
      success: z.boolean(),
      credits: z.number(),
    });

    expect(
      parseScrapeCreatorsSchema(
        schema,
        { success: true, credits: 42 },
        "credit-balance",
      ),
    ).toEqual({ success: true, credits: 42 });
  });

  test("throws ScrapeCreatorsApiError for malformed responses", () => {
    const schema = z.object({ credits: z.number() });

    expect(() =>
      parseScrapeCreatorsSchema(
        schema,
        { credits: "forty two" },
        "credit-balance",
      ),
    ).toThrow(ScrapeCreatorsApiError);
  });
});
