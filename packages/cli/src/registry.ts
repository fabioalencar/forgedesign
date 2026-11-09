import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { isJsonObject, readJsonFile } from "./json-file.js";

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

/** Read by `status`, the dashboard's project list, and every registered-project path. */
export async function readRegistry(): Promise<Registry> {
  const parsed = await readJsonFile(registryPath());
  const projects = isJsonObject(parsed) ? parsed.projects : undefined;
  return { projects: Array.isArray(projects) ? (projects as ProjectEntry[]) : [] };
}

async function writeRegistry(registry: Registry): Promise<void> {
  await fs.mkdir(forgeHome(), { recursive: true });
  await writeFileAtomic(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
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
