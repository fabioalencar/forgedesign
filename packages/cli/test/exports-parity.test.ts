import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import tsupConfig from "../tsup.config.js";

// The library surfaces are maintained by hand in TWO places — package.json
// `exports` and tsup.config `entry` — and drift is the known new-export build
// trap. These tests keep the pair honest so adding a surface to one without the
// other fails loudly instead of at dashboard typecheck time (T-126).

const dir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(dir, "..", "package.json"), "utf8")) as {
  exports: Record<string, { types: string; import: string }>;
};
const entries = (tsupConfig as unknown as { entry: string[] }).entry;

describe("cli exports ↔ tsup entry parity (T-126)", () => {
  it("every library entry has a matching exports subpath and vice versa", () => {
    // src/index.ts is the bin, not a library surface — exclude it.
    const fromTsup = entries
      .filter((entry) => entry !== "src/index.ts")
      .map((entry) => `./${entry.replace(/^src\//, "").replace(/\.ts$/, "")}`)
      .sort();
    expect(Object.keys(pkg.exports).sort()).toEqual(fromTsup);
  });

  it("each exports subpath points at the built dist files for its entry", () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const base = subpath.replace(/^\.\//, "");
      expect(target).toEqual({
        types: `./dist/${base}.d.ts`,
        import: `./dist/${base}.js`,
      });
    }
  });
});
