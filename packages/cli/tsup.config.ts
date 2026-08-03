import { defineConfig } from "tsup";

export default defineConfig({
  // index is the bin; other entries are library surfaces shared with the
  // dashboard (DDR-005 / DDR-013).
  entry: [
    "src/index.ts",
    "src/git.ts",
    "src/todo.ts",
    "src/task-ledger.ts",
    "src/registry.ts",
    "src/freezes.ts",
    "src/comments-client.ts",
    "src/preview.ts",
    "src/intake.ts",
    "src/scenarios.ts",
    "src/datasets.ts",
    "src/artifact-types.ts",
    "src/config.ts",
    "src/doctor.ts",
    "src/commands/comments.ts",
    "src/commands/explore.ts",
    "src/commands/init.ts",
    "src/commands/freeze.ts",
  ],
  format: ["esm"],
  target: "node20",
  clean: true,
  sourcemap: true,
  dts: true,
});
