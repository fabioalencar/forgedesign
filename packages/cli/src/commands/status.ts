import { promises as fs } from "node:fs";
import type { Command } from "commander";
import { projectUnfetchedCount, type UnfetchedCount } from "../comments-client.js";
import { readFreezes } from "../freezes.js";
import { currentBranch } from "../git.js";
import { readRegistry, registryPath } from "../registry.js";
import { readTaskCounts, type SectionCount } from "../task-ledger.js";

export interface FreezeEntry {
  tag: string;
  date: string;
}

export interface ProjectStatus {
  name: string;
  path: string;
  /** false when the registered directory no longer exists on disk */
  exists: boolean;
  branch: string | null;
  /** null when the project has no task ledger in any layout */
  todoCounts: SectionCount[] | null;
  lastFreeze: FreezeEntry | null;
  /** null until the comment API is wired up (Phase 2) */
  unfetchedComments: UnfetchedCount;
}

/** The most recent freeze (tag + date), or null when there are none/unreadable. */
async function readLastFreeze(root: string): Promise<FreezeEntry | null> {
  try {
    const last = (await readFreezes(root)).at(-1);
    return last ? { tag: last.tag, date: last.date } : null;
  } catch {
    // a corrupt freezes.json in one project must not break the whole rollup
    return null;
  }
}

export async function collectStatus(): Promise<ProjectStatus[]> {
  const registry = await readRegistry();
  return Promise.all(
    registry.projects.map(async (project): Promise<ProjectStatus> => {
      const exists = await fs
        .access(project.path)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        return {
          name: project.name,
          path: project.path,
          exists: false,
          branch: null,
          todoCounts: null,
          lastFreeze: null,
          unfetchedComments: { kind: "not-configured" },
        };
      }

      const [branch, todoCounts, lastFreeze, unfetchedComments] = await Promise.all([
        currentBranch(project.path),
        readTaskCounts(project.path)
          .then((reading) => reading?.counts ?? null)
          .catch(() => null),
        readLastFreeze(project.path),
        projectUnfetchedCount(project.path),
      ]);

      return {
        name: project.name,
        path: project.path,
        exists: true,
        branch,
        todoCounts,
        lastFreeze,
        unfetchedComments,
      };
    }),
  );
}

/** Each reason gets its own sentence, and each names the next move. */
function describeUnfetched(result: UnfetchedCount): string {
  switch (result.kind) {
    case "count":
      return String(result.count);
    case "not-configured":
      return "n/a (not signed in — run `forge login`)";
    case "no-snapshots":
      return "n/a (no freeze has registered a snapshot yet)";
    case "unreachable":
      return "unknown (the comment API did not answer — check the URL and key)";
  }
}

export function formatStatus(statuses: ProjectStatus[]): string {
  if (statuses.length === 0) {
    return `No projects registered. Run \`forge init\` in a design repo to register it (registry: ${registryPath()}).`;
  }

  const blocks = statuses.map((s) => {
    const lines = [`${s.name}  ${s.path}`];
    if (!s.exists) {
      lines.push("  missing on disk (directory not found)");
      return lines.join("\n");
    }
    lines.push(`  branch: ${s.branch ?? "not a git repo"}`);
    if (s.todoCounts === null) {
      lines.push("  todos: no task ledger");
    } else {
      const open = s.todoCounts.filter((c) => c.open > 0);
      lines.push(
        open.length === 0
          ? "  todos: none open"
          : `  todos: ${open.map((c) => `${c.section} ${c.open}`).join(" · ")}`,
      );
    }
    lines.push(
      s.lastFreeze
        ? `  last freeze: ${s.lastFreeze.tag} (${s.lastFreeze.date})`
        : "  last freeze: never",
    );
    lines.push(`  unfetched comments: ${describeUnfetched(s.unfetchedComments)}`);
    return lines.join("\n");
  });

  return blocks.join("\n\n");
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description(
      "show every registered project: current branch, open todos by section, last freeze, unfetched comments",
    )
    .action(async () => {
      console.log(formatStatus(await collectStatus()));
    });
}
