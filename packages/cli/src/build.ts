import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { splitCommand } from "./preview.js";
import { type BuildConfig, readProjectFile } from "./project.js";

const execFileAsync = promisify(execFile);

/**
 * What to add to forge.json, spelled out in every message that asks for it.
 *
 * These errors used to end in `(DDR-052)`, which is unreadable twice over from
 * outside this repo: the public record has no DDR-052, and a user's *own* record
 * eventually will — a different decision entirely (TASK-415). A citation nobody
 * can follow is worth less than the two lines it takes to say the thing.
 */
const BUILD_BLOCK_EXAMPLE =
  'add a "build" block to forge.json, e.g.\n' +
  '  "build": { "command": "npm run build", "output": "dist" }\n' +
  'where "output" is the directory that command writes. Optional: "dir" if the app\n' +
  'lives in a subdirectory, and "storybook" taking the same command/output pair.';

export type PackageManager = "pnpm" | "yarn" | "npm";

/** Detected from the prototype's lockfile; npm is the fallback. */
export async function detectPackageManager(dir: string): Promise<PackageManager> {
  const has = (f: string) =>
    fs
      .access(path.join(dir, f))
      .then(() => true)
      .catch(() => false);
  if (await has("pnpm-lock.yaml")) return "pnpm";
  if (await has("yarn.lock")) return "yarn";
  return "npm";
}

export interface PrototypeBuilds {
  /** static prototype export, e.g. prototype/dist */
  prototypeDir: string;
  /** built Storybook, or null when the project declares none (DDR-052) */
  storybookDir: string | null;
}

/** One build step resolved to an argv, a working directory, and its output. */
interface BuildStep {
  argv: string[];
  cwd: string;
  output: string;
  /** Names the step in error messages ("build", "storybook build"). */
  label: string;
}

async function runStep(step: BuildStep): Promise<string> {
  try {
    await execFileAsync(step.argv[0] as string, step.argv.slice(1), {
      cwd: step.cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`prototype ${step.label} failed:\n${stderr || String(error)}`);
  }
  try {
    await fs.access(step.output);
  } catch {
    throw new Error(`build succeeded but expected output ${step.output} is missing`);
  }
  return step.output;
}

/**
 * forge.json's `build` block (DDR-052) — the project declares its own command
 * and output, so freeze works on a real repo with a real stack. Storybook is
 * optional; absent means the freeze carries no Storybook.
 */
async function configuredSteps(repoRoot: string, config: BuildConfig): Promise<BuildStep[]> {
  if (!config.command?.trim()) {
    throw new Error('forge.json "build" needs a "command" — e.g. "command": "npm run build"');
  }
  if (!config.output?.trim()) {
    throw new Error('forge.json "build" needs an "output" directory — e.g. "output": "dist"');
  }
  const cwd = path.resolve(repoRoot, config.dir?.trim() || ".");
  try {
    await fs.access(cwd);
  } catch {
    throw new Error(`forge.json "build.dir" points at ${cwd}, which does not exist`);
  }
  const steps: BuildStep[] = [
    {
      argv: splitCommand(config.command),
      cwd,
      output: path.resolve(cwd, config.output),
      label: "build",
    },
  ];
  const storybook = config.storybook;
  if (storybook) {
    if (!storybook.command?.trim() || !storybook.output?.trim()) {
      throw new Error('forge.json "build.storybook" needs both a "command" and an "output"');
    }
    steps.push({
      argv: splitCommand(storybook.command),
      cwd,
      output: path.resolve(cwd, storybook.output),
      label: "storybook build",
    });
  }
  return steps;
}

/**
 * The pre-pivot scaffold convention: prototype/ with `build` and
 * `build-storybook` scripts, output at dist/ and storybook-static/. Kept as the
 * fallback for repos old `forge init` created; retires with T-236.
 */
async function scaffoldSteps(repoRoot: string): Promise<BuildStep[]> {
  const prototype = path.join(repoRoot, "prototype");
  let scripts: Record<string, string>;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(prototype, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    throw new Error(
      `forge.json declares no "build", and there is no prototype/package.json to fall back on — ${BUILD_BLOCK_EXAMPLE}`,
    );
  }
  for (const script of ["build", "build-storybook"]) {
    if (!scripts[script]) {
      throw new Error(`prototype/package.json has no "${script}" script — cannot freeze`);
    }
  }
  const pm = await detectPackageManager(prototype);
  return [
    {
      argv: [pm, "run", "build"],
      cwd: prototype,
      output: path.join(prototype, "dist"),
      label: "build",
    },
    {
      argv: [pm, "run", "build-storybook"],
      cwd: prototype,
      output: path.join(prototype, "storybook-static"),
      label: "storybook build",
    },
  ];
}

/**
 * Builds what the project declares (spec §2 step 3). forge.json's `build` block
 * wins; without one, the prototype/ scaffold convention applies. Steps run in
 * order so a failing build reports before Storybook is attempted.
 */
/**
 * Where the prototype build lands, without running the build (DDR-052's
 * `build.output`). `forge publish` needs the directory, not a fresh build:
 * hosting should carry the artifact the freeze produced, and rebuilding could
 * quietly publish something the tag never contained.
 */
export async function prototypeOutputDir(repoRoot: string): Promise<string | null> {
  const config = (await readProjectFile(repoRoot)).build;
  const output = config?.output?.trim();
  if (!output) return null;
  return path.resolve(repoRoot, config?.dir?.trim() || ".", output);
}

export async function buildPrototype(repoRoot: string): Promise<PrototypeBuilds> {
  const config = (await readProjectFile(repoRoot)).build;
  const steps = config ? await configuredSteps(repoRoot, config) : await scaffoldSteps(repoRoot);

  const outputs: string[] = [];
  for (const step of steps) outputs.push(await runStep(step));

  return { prototypeDir: outputs[0] as string, storybookDir: outputs[1] ?? null };
}
