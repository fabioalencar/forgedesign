import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ProjectEntry {
  name: string;
  path: string;
  createdAt: string;
}

export interface Registry {
  projects: ProjectEntry[];
}

// FORGE_HOME overrides ~/.forge so tests (and parallel setups) never touch the real registry.
export function forgeHome(): string {
  return process.env.FORGE_HOME ?? path.join(homedir(), ".forge");
}

export function registryPath(): string {
  return path.join(forgeHome(), "projects.json");
}

export async function readRegistry(): Promise<Registry> {
  try {
    const raw = await fs.readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Registry>;
    return { projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { projects: [] };
    }
    throw error;
  }
}

async function writeRegistry(registry: Registry): Promise<void> {
  await fs.mkdir(forgeHome(), { recursive: true });
  await fs.writeFile(registryPath(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

/** Upserts by absolute path, so re-running `forge init` never duplicates an entry. */
export async function registerProject(entry: { name: string; path: string }): Promise<Registry> {
  const registry = await readRegistry();
  const existing = registry.projects.find((p) => p.path === entry.path);
  if (existing) {
    existing.name = entry.name;
  } else {
    registry.projects.push({ ...entry, createdAt: new Date().toISOString() });
  }
  await writeRegistry(registry);
  return registry;
}
