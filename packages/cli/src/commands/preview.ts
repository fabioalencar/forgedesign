import type { Command } from "commander";
import { listPreviews, splitCommand, startPreview, stopPreview } from "../preview.js";

export { splitCommand } from "../preview.js";

/**
 * Split a dev command into argv, honoring single/double quotes so a quoted arg
 * (e.g. --name "my app") survives instead of being split on its inner space.
 */
export function registerPreviewCommand(program: Command): void {
  const preview = program
    .command("preview")
    .description("live dev-server preview of the current branch");

  preview
    .command("start")
    .option("--dir <dir>", "directory inside the worktree to run in", "prototype")
    .option(
      "--command <cmd>",
      'dev command ("{port}" is replaced), e.g. "pnpm dev -- --port {port}"',
    )
    .description(
      "run this branch's dev server in a detached .forge/preview/<branch> worktree — executes the repo's own scripts, at the last commit",
    )
    .action(async (opts: { dir: string; command?: string }) => {
      const record = await startPreview({
        dir: opts.dir,
        command: opts.command ? splitCommand(opts.command) : undefined,
        log: console.log,
      });
      console.log(`\n${record.branch} → ${record.url}`);
      console.log(`  command: ${record.command}`);
      console.log(`  worktree: ${record.worktree}`);
      console.log(`  stop with: forge preview stop ${record.name}`);
    });

  preview
    .command("stop")
    .argument("<name>", "preview name, as shown by `forge preview status`")
    .option("--remove-worktree", "also remove the .forge/preview/<name> worktree")
    .description("stop the preview's dev server (worktree kept unless --remove-worktree)")
    .action(async (name: string, opts: { removeWorktree?: boolean }) => {
      const { stopped } = await stopPreview({
        name,
        removeWorktree: opts.removeWorktree,
        log: console.log,
      });
      if (!stopped) console.log(`No running preview named "${name}".`);
    });

  preview
    .command("status")
    .description("list previews; stale records from dead servers are cleaned up")
    .action(async () => {
      const statuses = await listPreviews();
      if (statuses.length === 0) {
        console.log("No previews.");
        return;
      }
      for (const s of statuses) {
        console.log(
          s.running
            ? `● ${s.name} ${s.url} (pid ${s.pid}, since ${s.startedAt})`
            : `○ ${s.name} not running (stale record cleaned)`,
        );
      }
    });
}
