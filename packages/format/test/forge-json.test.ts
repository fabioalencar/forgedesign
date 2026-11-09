import { describe, expect, it } from "vitest";
import {
  buildForgeManifest,
  isSupportedFormatVersion,
  parseForgeJson,
  recordRootOf,
  serializeForgeJson,
  V02_FORMAT_VERSION,
} from "../src/forge-json.js";

describe("buildForgeManifest / serializeForgeJson", () => {
  it("stamps the current format version by default", () => {
    const manifest = buildForgeManifest();
    expect(manifest.formatVersion).toBe(V02_FORMAT_VERSION);
    expect(serializeForgeJson(manifest)).toBe('{\n  "formatVersion": "0.2"\n}\n');
  });

  it("allows overrides alongside formatVersion", () => {
    const manifest = buildForgeManifest({ name: "acme" });
    expect(manifest).toEqual({ formatVersion: "0.2", name: "acme" });
  });
});

describe("parseForgeJson", () => {
  it("parses a well-formed manifest", () => {
    expect(parseForgeJson('{"formatVersion": "0.1"}')).toEqual({ formatVersion: "0.1" });
  });

  it("rejects a non-object JSON value", () => {
    expect(() => parseForgeJson("[]")).toThrow();
    expect(() => parseForgeJson("42")).toThrow();
  });
});

describe("isSupportedFormatVersion", () => {
  it("accepts the current version", () => {
    expect(isSupportedFormatVersion("0.1")).toBe(true);
  });

  it("rejects an unknown or missing version", () => {
    expect(isSupportedFormatVersion("9.9")).toBe(false);
    expect(isSupportedFormatVersion(undefined)).toBe(false);
  });
});

describe("recordRootOf (TASK-528)", () => {
  it("returns the bundle directory a manifest names, and design when it names none", () => {
    expect(recordRootOf({ recordRoot: "design" })).toBe("design");
    expect(recordRootOf({ recordRoot: "docs/record" })).toBe("docs/record");
    expect(recordRootOf({ recordRoot: "./design/" })).toBe("./design/");
    expect(recordRootOf({})).toBe("design");
    expect(recordRootOf({ recordRoot: 7 })).toBe("design");
  });

  it("refuses a recordRoot that leaves the repository", () => {
    for (const recordRoot of [
      "..",
      "../shared",
      "design/../../x",
      "/etc",
      "C:\\record",
      "..\\up",
    ]) {
      expect(recordRootOf({ recordRoot })).toBeNull();
    }
  });
});
