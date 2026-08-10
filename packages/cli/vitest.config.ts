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
 * That fix relocated the file but kept it shared, so the race survived it and
 * fired again on 2026-08-10 the moment another test file started calling
 * `forge init`. The directory is now per worker, which removes the race rather
 * than moving it — see `test/setup-forge-home.ts`, which has to run as a setup
 * file because the worker id only exists inside the worker.
 */
export default defineConfig({
  test: {
    setupFiles: ["./test/setup-forge-home.ts"],
  },
});
