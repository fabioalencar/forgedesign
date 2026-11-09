import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { isJsonObject, readJsonFile } from "./json-file.js";
import { forgeHome } from "./registry.js";

/** Per-user settings in ~/.forge/config.json (FORGE_HOME-overridable). */
export interface UserConfig {
  /** a self-hosted comment API's base URL — operators only; creators use `forge login` (DDR-104) */
  commentsApiUrl?: string;
  /** the COMMENTS_API_KEY configured on that deployment (DDR-009) */
  commentsApiKey?: string;
  /** Vercel team slug for freeze deploys — required when the account has more than one */

  /** Forge Cloud base URL; defaults to the hosted service (DDR-075) */
  cloudApiUrl?: string;
  /** this machine's Cloud session, from `forge login` — revocable on its own */
  cloudToken?: string;
}

export function configPath(): string {
  return path.join(forgeHome(), "config.json");
}

export async function readUserConfig(): Promise<UserConfig> {
  const parsed = await readJsonFile(configPath());
  return isJsonObject(parsed) ? (parsed as UserConfig) : {};
}

/**
 * Merges `changes` into the stored config. Keys set to `undefined` are removed
 * rather than written as null, so clearing a setting leaves the file looking
 * like it was never set. Written 0600 — it holds an API key.
 */
export async function writeUserConfig(changes: Partial<UserConfig>): Promise<UserConfig> {
  const merged: UserConfig = { ...(await readUserConfig()), ...changes };
  for (const key of Object.keys(merged) as Array<keyof UserConfig>) {
    if (merged[key] === undefined) delete merged[key];
  }
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  // Exactly 0600 every time, not only when the file is new: a config written
  // 0644 by anything else kept 0644, token included (TASK-535).
  await writeFileAtomic(configPath(), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged;
}
