import { promises as fs } from "node:fs";
import path from "node:path";
import { forgeHome } from "./registry.js";

/** Per-user settings in ~/.forge/config.json (FORGE_HOME-overridable). */
export interface UserConfig {
  /** base URL of the deployed comment API, e.g. https://forge-comments.vercel.app */
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
  try {
    return JSON.parse(await fs.readFile(configPath(), "utf8")) as UserConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
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
  await fs.writeFile(configPath(), `${JSON.stringify(merged, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return merged;
}
