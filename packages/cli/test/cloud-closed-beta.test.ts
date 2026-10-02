import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { CLOUD_HELP_GROUP } from "../src/cloud-auth.js";
import { registerCommentsCommand } from "../src/commands/comments.js";
import { registerCloudAuthCommands } from "../src/commands/login.js";
import { registerPublishCommand } from "../src/commands/publish.js";
import { formatStatus, type ProjectStatus } from "../src/commands/status.js";
import { commentsApiFor } from "../src/comments-client.js";

// Forge Cloud is not open for sign-up (DDR-137). The open-source CLI works in
// full without it, and nothing it prints may send someone to sign up for it.

/** The commands `--help` lists under one heading, by name. */
function group(help: string, heading: string): string[] {
  const start = help.indexOf(heading);
  if (start === -1) return [];
  const body = help.slice(start + heading.length).split(/\n\n/)[0] ?? "";
  return [...body.matchAll(/^ {2}(\S+)/gm)].map((match) => match[1] as string);
}

describe("Forge Cloud in --help", () => {
  it("lists every Cloud command under a heading that says it is a closed beta", () => {
    const program = new Command("forge");
    registerCloudAuthCommands(program);
    registerPublishCommand(program);
    expect(CLOUD_HELP_GROUP).toMatch(/closed beta/);
    expect(group(program.helpInformation(), CLOUD_HELP_GROUP)).toEqual([
      "login",
      "logout",
      "whoami",
      "publish",
      "unpublish",
    ]);
  });

  it("keeps the comment commands that need no account outside it, and first", () => {
    const program = new Command("forge");
    registerCommentsCommand(program);
    const comments = program.commands.find((command) => command.name() === "comments");
    const help = comments?.helpInformation() ?? "";
    expect(group(help, CLOUD_HELP_GROUP)).toEqual(["archive", "window", "resolve"]);
    expect(group(help, "Commands:")).toEqual(["import", "triage", "help"]);
    expect(help.indexOf("Commands:")).toBeLessThan(help.indexOf(CLOUD_HELP_GROUP));
  });
});

describe("without a Forge Cloud account", () => {
  it("refuses a Cloud command by saying it is a closed beta, and names the way in without one", () => {
    expect(() => commentsApiFor({})).toThrow(/closed beta/);
    expect(() => commentsApiFor({})).toThrow(/forge comments import/);
  });

  it("leaves the comments line out of forge status rather than advertise the beta", () => {
    const status: ProjectStatus = {
      name: "demo",
      path: "/tmp/demo",
      exists: true,
      branch: "main",
      todoCounts: null,
      lastFreeze: null,
      unfetchedComments: { kind: "not-configured" },
    };
    expect(formatStatus([status])).not.toContain("comments");
    expect(formatStatus([{ ...status, unfetchedComments: { kind: "count", count: 2 } }])).toContain(
      "unfetched comments: 2",
    );
  });
});
