import { describe, expect, it } from "vitest";
import { countFindings, describeFindings, parseCheckReport } from "../src/checks.js";

const REPORT = {
  checker: "vizlint",
  version: "0.3.1",
  score: 87,
  summary: "Two contrast failures on the sign-in screen.",
  findings: [
    {
      rule: "contrast-aa",
      severity: "error",
      message: "Body text on the sign-in card is 3.2:1 against its background.",
      route: "/",
      selector: "main p",
      fix: "Use the on-surface token.",
    },
    {
      rule: "touch-target",
      severity: "warning",
      message: "The forgot-password link is 28px tall.",
    },
    { rule: "note", severity: "info", message: "Scanned 3 routes." },
  ],
};

describe("parseCheckReport (DDR-127)", () => {
  it("reads the contract shape and keeps only the fields the report gave", () => {
    const report = parseCheckReport(REPORT);
    expect(report).toEqual({
      checker: "vizlint",
      version: "0.3.1",
      score: 87,
      summary: "Two contrast failures on the sign-in screen.",
      findings: [
        {
          rule: "contrast-aa",
          severity: "error",
          message: "Body text on the sign-in card is 3.2:1 against its background.",
          route: "/",
          selector: "main p",
          fix: "Use the on-surface token.",
        },
        {
          rule: "touch-target",
          severity: "warning",
          message: "The forgot-password link is 28px tall.",
        },
        { rule: "note", severity: "info", message: "Scanned 3 routes." },
      ],
    });
    expect(countFindings(report)).toEqual({ error: 1, warning: 1, info: 1 });
    expect(describeFindings(report)).toBe("1 error, 1 warning, 1 info");
  });

  it("accepts the minimum a checker can say", () => {
    const report = parseCheckReport({ checker: "doctor", findings: [] });
    expect(report).toEqual({
      checker: "doctor",
      version: null,
      score: null,
      summary: null,
      findings: [],
    });
    expect(describeFindings(report)).toBe("no findings");
  });

  it.each([
    [{ findings: [] }, /"checker" is required/],
    [{ checker: "a/b", findings: [] }, /usable as a filename/],
    [{ checker: "x" }, /"findings" must be an array/],
    [{ checker: "x", findings: [{ rule: "r", severity: "fatal", message: "m" }] }, /severity/],
    [{ checker: "x", findings: [{ rule: "r", severity: "error" }] }, /"message" is required/],
    [{ checker: "x", findings: [], score: "high" }, /"score" must be a number/],
    ["not even json", /JSON object/],
  ])("refuses %j with the field named", (payload, error) => {
    expect(() => parseCheckReport(payload)).toThrow(error);
  });
});
