// One throwaway `FORGE_HOME` **per worker**, not one for the whole run
// (TASK-421).
//
// `forge init` registers what it creates in `$FORGE_HOME/projects.json`, so
// every test that inits a fixture appends to that file. Pointing it at a shared
// temp directory (the 2026-08-03 fix) stopped tests writing into the developer's
// own registry, but left the concurrency untouched: the registry is a
// read-modify-write, vitest runs files in parallel workers, and two workers
// appending at once produce invalid JSON. That is not hypothetical — it
// happened in August, was "fixed" by relocating the file, and happened again the
// moment a new test file added one more concurrent writer, by which point the
// shared file had grown to 81KB of interleaved runs.
//
// Keying the path by worker gives each writer its own file, so no interleaving
// is possible regardless of how many test files init a fixture. Files that need
// their own `FORGE_HOME` — because they write a `config.json` beside it — still
// override this in their own setup, and now they are isolating themselves from
// one worker rather than from everybody.
//
// It is deleted before each run rather than after, so a crashed run leaves
// evidence to read instead of erasing it.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const worker = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "0";
const home = path.join(tmpdir(), "forge-cli-test-home", `worker-${worker}`);

await fs.rm(home, { recursive: true, force: true });
await fs.mkdir(home, { recursive: true });
process.env.FORGE_HOME = home;
