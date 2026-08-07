import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { coreScaffold, pathState } from "@forgedesign/format";
import type { Command } from "commander";
import { registerProject, registryPath } from "../registry.js";

const execFileAsync = promisify(execFile);

export interface InitResult {
  root: string;
  name: string;
  written: string[];
  skipped: string[];
  /** Core files a differently-cased file already occupies the path of. */
  blocked: Array<{ target: string; variant: string }>;
  gitInitialized: boolean;
  gitIgnoreUpdated: boolean;
  gitWarning?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `.forge/` is runtime state — preview worktrees, staged intake, job logs —
 * never record content, so it does not belong in a user's history. Appends the
 * rule when it isn't already covered; leaves an existing .gitignore otherwise
 * untouched.
 */
async function ignoreForgeState(root: string): Promise<boolean> {
  const file = path.join(root, ".gitignore");
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current.split("\n").some((line) => line.trim().replace(/\/$/, "") === ".forge")) return false;
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  await fs.writeFile(file, `${prefix}.forge/\n`, "utf8");
  return true;
}

/**
 * Creates the Design Record's core file set in `targetDir` and registers the
 * project (spec/format.md §2; DDR-050 — Forge is the record, not the build
 * tool, so this scaffolds documents and nothing else: no prototype, no
 * starter, no token set, no artifact folders).
 *
 * Additive and idempotent by design. Adopting a repo that already has work in
 * it is the normal case, not a special one, so an existing file is reported
 * and never overwritten — including a partially-adopted record.
 */
export async function initProject(targetDir: string): Promise<InitResult> {
  const root = path.resolve(targetDir);
  const name = path.basename(root);
  await fs.mkdir(root, { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];
  const blocked: InitResult["blocked"] = [];
  for (const [relPath, content] of Object.entries(coreScaffold())) {
    const absPath = path.join(root, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    // Case-exactly: a `TODOS.md` next to a record wanting `Todos.md` is not
    // "already scaffolded", it is a path this record cannot have.
    const state = await pathState(absPath);
    if (state.kind === "present") {
      skipped.push(relPath);
      continue;
    }
    if (state.kind === "collision") {
      blocked.push({ target: relPath, variant: state.found });
      continue;
    }
    await fs.writeFile(absPath, content, "utf8");
    written.push(relPath);
  }

  let gitInitialized = false;
  let gitWarning: string | undefined;
  if (!(await exists(path.join(root, ".git")))) {
    try {
      await execFileAsync("git", ["init"], { cwd: root });
      gitInitialized = true;
    } catch (error) {
      gitWarning = `git init failed (${error instanceof Error ? error.message : String(error)}); initialize Git manually — the record lives in Git and freeze needs it.`;
    }
  }
  const gitIgnoreUpdated = await ignoreForgeState(root);

  await registerProject({ name, path: root });

  return { root, name, written, skipped, blocked, gitInitialized, gitIgnoreUpdated, gitWarning };
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .argument("[name]", "directory to create (defaults to the current directory)")
    .description(
      "create the Design Record's core files (design/index.md, brief.md, todos.md, decisions/, forge.json) and register the project; existing files are never overwritten",
    )
    .action(async (name: string | undefined) => {
      const result = await initProject(name ?? process.cwd());

      console.log(`Initialized the Design Record for "${result.name}" at ${result.root}`);
      if (result.written.length > 0) {
        console.log(`  created: ${result.written.join(", ")}`);
      }
      if (result.skipped.length > 0) {
        console.log(`  kept existing: ${result.skipped.join(", ")}`);
      }
      for (const { target, variant } of result.blocked) {
        console.warn(
          `  warning: could not create ${target} — ${variant} differs from it only by case, ` +
            `and on this filesystem they are the same path. Rename ${variant}, then rerun.`,
        );
      }
      if (result.gitInitialized) console.log("  initialized Git repository");
      if (result.gitIgnoreUpdated) console.log("  added .forge/ to .gitignore");
      if (result.gitWarning) console.warn(`  warning: ${result.gitWarning}`);
      console.log(`  registered in ${registryPath()}`);
      console.log("\nNext steps:");
      if (name) console.log(`  cd ${name}`);
      console.log("  fill in design/brief.md — everything else grows from it");
      console.log("  forge doctor");
    });
}
