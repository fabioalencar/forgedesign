// forge.json (spec/format.md §2, §7) — project manifest, carries formatVersion.

/** The root-file layout that predates the OKF bundle. Still read, no longer written. */
export const V01_FORMAT_VERSION = "0.1";
/** The OKF-conformant bundle format (spec/format.md v0.2). */
export const V02_FORMAT_VERSION = "0.2";
// What a new record gets is `V02_FORMAT_VERSION`; writers name it directly
// rather than through an alias, so there is exactly one spelling per version.
// Both are understood: v0.1 stays readable so a repo that has not migrated is
// not suddenly invalid, and `forge upgrade --to 0.2` is what moves it forward.
export const SUPPORTED_FORMAT_VERSIONS = [V01_FORMAT_VERSION, V02_FORMAT_VERSION] as const;

export interface ForgeManifest {
  formatVersion: string;
  [key: string]: unknown;
}

export function isSupportedFormatVersion(version: string | undefined): boolean {
  return (
    typeof version === "string" &&
    (SUPPORTED_FORMAT_VERSIONS as readonly string[]).includes(version)
  );
}

export function parseForgeJson(text: string): ForgeManifest {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("forge.json must be a JSON object");
  }
  return parsed as ForgeManifest;
}

export function buildForgeManifest(overrides: Partial<ForgeManifest> = {}): ForgeManifest {
  return { formatVersion: V02_FORMAT_VERSION, ...overrides };
}

export function serializeForgeJson(manifest: ForgeManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
