import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // The runtime ships inside a frozen build a stakeholder loads in a browser,
  // so it targets the browser, carries no dependencies, and stays small.
  target: "es2022",
  platform: "browser",
  clean: true,
  sourcemap: true,
  dts: true,
});
