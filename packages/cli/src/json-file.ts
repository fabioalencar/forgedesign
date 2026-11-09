import { promises as fs } from "node:fs";

/**
 * A JSON file's parsed contents, or `undefined` when there is no file
 * (TASK-542).
 *
 * The state files — `~/.forge/config.json` and `projects.json`, a repo's
 * `forge.json` and `freezes.json` — are read by nearly every command and by the
 * dashboard, and each is hand-editable and merge-able, so each is sometimes
 * broken. A broken one must name itself rather than crash its readers with a
 * bare parser line that says no file (TASK-411). Four readers carried that rule
 * as four copies; the shape each expects is still the caller's to check.
 */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${file} is not valid JSON — fix or delete it (${(error as Error).message})`);
  }
}

/** A JSON object — not null, not an array — whose keys a reader may look at. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
