import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Point `FORGE_HOME` at a throwaway directory for every test in this package.
 *
 * `forge init` registers the project it creates in `~/.forge/projects.json`, so
 * any test that inits a fixture writes into the *developer's own* registry
 * unless something redirects it. Several test files already set `FORGE_HOME`
 * themselves; the ones that did not had been quietly appending a `demo` entry
 * per run for months, and on 2026-08-03 two workers appending at once left the
 * file invalid JSON — which then failed every test that read it, in a way whose
 * error pointed at the registry rather than at the tests that filled it.
 *
 * Setting it here rather than per file means a new test cannot forget. Files
 * that need their own `FORGE_HOME` (for a config.json beside it) still override
 * this in their own setup.
 */
export default defineConfig({
  test: {
    env: {
      FORGE_HOME: path.join(tmpdir(), "forgedesign-cli-test-home"),
    },
  },
});
