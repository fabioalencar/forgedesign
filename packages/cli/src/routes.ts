// Which screens changed, per freeze (TASK-461, DDR-121).
//
// A freeze is a static build with one directory per route (DDR-072), so the
// screens a version has are discoverable with no framework knowledge: every
// `index.html` is one. `forge freeze` hashes each one onto the freeze record,
// and "which screens changed" is then a comparison between two freezes'
// hashes — derived the way the feature log derives "what closed": from what
// the freeze recorded, never from a field somebody has to maintain.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FreezeRecord } from "./freezes.js";

/** `route → sha256:<hex>` of the built `index.html` at that route. */
export type RouteHashes = Record<string, string>;

/**
 * A route as the record names it: leading slash, no trailing slash except the
 * root, no query or fragment. Feedback carries the route a reviewer was on
 * (`/register/` or `/register?x=1`), the build carries a directory — this is
 * what lets the two meet.
 */
export function normalizeRoute(route: string): string {
  const bare = route.replace(/[?#].*$/, "").trim();
  const withSlash = bare.startsWith("/") ? bare : `/${bare}`;
  const trimmed = withSlash.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

async function walk(dir: string, route: string, out: RouteHashes): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name), `${route}/${entry.name}`, out);
    } else if (entry.isFile() && entry.name === "index.html") {
      const bytes = await fs.readFile(path.join(dir, entry.name));
      out[route === "" ? "/" : route] =
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    }
  }
}

/**
 * The content hash of every route in a built prototype, keyed by route and
 * sorted so two freezes of the same build produce the same object. Only
 * `index.html` counts as a screen — assets change with every fingerprinted
 * build and are not what a stakeholder means by "the sign-in page changed".
 */
export async function hashBuiltRoutes(buildDir: string): Promise<RouteHashes> {
  const hashes: RouteHashes = {};
  await walk(buildDir, "", hashes);
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}

export type ScreenStatus = "new" | "changed" | "unchanged" | "removed";

export interface ScreenChange {
  route: string;
  status: ScreenStatus;
}

/**
 * What can honestly be said about a freeze's screens, which depends on what
 * the freeze before it recorded:
 * - `unrecorded` — this freeze carries no hashes (cut before they existed);
 * - `first` — no freeze before it, so every screen is new;
 * - `baseline-unrecorded` — the previous freeze carries no hashes, so the
 *   routes are known and the comparison is not;
 * - `compared` — both sides hashed; each route has a status.
 */
export type ScreenComparison =
  | { kind: "unrecorded" }
  | { kind: "first"; screens: ScreenChange[] }
  | { kind: "baseline-unrecorded"; previousTag: string; routes: string[] }
  | { kind: "compared"; previousTag: string; screens: ScreenChange[] };

export function compareScreens(
  current: FreezeRecord,
  previous: FreezeRecord | null,
): ScreenComparison {
  const routes = current.routes;
  if (!routes) return { kind: "unrecorded" };
  const currentRoutes = Object.keys(routes).sort((a, b) => a.localeCompare(b));

  if (previous === null) {
    return { kind: "first", screens: currentRoutes.map((route) => ({ route, status: "new" })) };
  }
  const before = previous.routes;
  if (!before)
    return { kind: "baseline-unrecorded", previousTag: previous.tag, routes: currentRoutes };

  const all = [...new Set([...currentRoutes, ...Object.keys(before)])].sort((a, b) =>
    a.localeCompare(b),
  );
  const screens: ScreenChange[] = all.map((route) => {
    const now = routes[route];
    const then = before[route];
    if (now === undefined) return { route, status: "removed" };
    if (then === undefined) return { route, status: "new" };
    return { route, status: now === then ? "unchanged" : "changed" };
  });
  return { kind: "compared", previousTag: previous.tag, screens };
}

/** The routes a comparison says moved — new, changed or removed — in route order. */
export function changedRoutes(comparison: ScreenComparison): ScreenChange[] {
  if (comparison.kind !== "compared" && comparison.kind !== "first") return [];
  return comparison.screens.filter((screen) => screen.status !== "unchanged");
}
