import { tool } from "@openai/agents";
import { z } from "zod";
import { toolLogger } from "../logger";
import { evaluate } from "mathjs";
import { formatError } from "../utils/types";

const MAX_EXPRESSION_LENGTH = 500;
const MAX_RESULT_LENGTH = 2000;

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_LENGTH) return result;
  return result.slice(0, MAX_RESULT_LENGTH - 3) + "...";
}

export const calculatorTool = tool({
  name: "calculator",
  description:
    "Perform mathematical calculations. Supports basic arithmetic (+, -, *, /, %), exponents (^), square roots, trigonometry, logarithms, matrices, units, and more. Use this for any math the user asks about.",
  parameters: z.object({
    expression: z
      .string()
      .describe(
        "A mathjs expression to evaluate. Supports: arithmetic (2+2, 10/3), exponents (2^8), functions (sqrt, sin, cos, tan, log, ln, abs, round, floor, ceil), trigonometry with units (sin(45 deg)), unit conversions (5 inches to cm, 100 km/h to mph), matrices (det([[1,2],[3,4]]), inv(matrix)), complex numbers (sqrt(-1), 2+3i), constants (pi, e, phi), and more.",
      ),
  }),
  execute: async ({ expression }) => {
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      return {
        expression: expression.slice(0, MAX_EXPRESSION_LENGTH),
        error: `Expression is too long. Keep it under ${MAX_EXPRESSION_LENGTH} characters.`,
      };
    }

    toolLogger.info({ expression }, "Calculating expression");
    try {
      const result = truncateResult(String(evaluate(expression)));
      toolLogger.info({ expression, result }, "Calculation complete");
      return { expression, result };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { expression, error: errorMessage },
        "Calculation failed",
      );
      return { expression, error: errorMessage };
    }
  },
});
