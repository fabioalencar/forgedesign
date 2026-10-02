// Where `forge comments` talks, and with which credential (DDR-104, TASK-420).
//
// The bug this closes is not subtle once seen: `commentsApiKey` is one
// deployment-wide secret that authorises **every tenant's** comments, so it
// could never be handed to a customer — and until now it was the only thing
// `forge comments` would read. Every subcommand refused a Cloud creator with an
// instruction they had no way to follow, so the review loop ran comment →
// nothing.

import { describe, expect, it } from "vitest";
import { commentsApiFor } from "../src/comments-client.js";

describe("commentsApiFor", () => {
  it("goes through the control plane when the machine is signed in", () => {
    // The `cloudToken` is what `forge login` writes, and the control plane is
    // the only plane that knows who owns which snapshot.
    expect(
      commentsApiFor({ cloudToken: "tok-123", cloudApiUrl: "https://useforge.design" }),
    ).toEqual({ apiUrl: "https://useforge.design/api/cli", apiKey: "tok-123" });
  });

  it("mirrors the review plane's paths under /api/cli, so the client is unchanged", () => {
    // The base URL ends at `/api/cli` precisely so `comments-client` keeps
    // appending `/comments`, `/comments/resolve` and `/snapshots/:id/archive`
    // exactly as it does against the review plane.
    const api = commentsApiFor({ cloudToken: "t" });
    expect(api.apiUrl.endsWith("/api/cli")).toBe(true);
  });

  it("defaults to the hosted control plane, and tolerates a trailing slash", () => {
    expect(commentsApiFor({ cloudToken: "t" }).apiUrl).toBe("https://useforge.design/api/cli");
    expect(commentsApiFor({ cloudToken: "t", cloudApiUrl: "https://x.test/" }).apiUrl).toBe(
      "https://x.test/api/cli",
    );
  });

  it("prefers Cloud over a direct key when a machine holds both", () => {
    // An operator's machine has both. Taking the customer's path there is what
    // keeps breakage visible instead of hiding behind a credential nobody else
    // has — the exact blindness that let this gap exist (TASK-416's shape).
    expect(
      commentsApiFor({
        cloudToken: "tok-123",
        commentsApiUrl: "https://review.example",
        commentsApiKey: "sk-shared",
      }).apiKey,
    ).toBe("tok-123");
  });

  it("keeps the direct config as the self-host and operator escape hatch", () => {
    // DDR-104 left it as exactly that, and no more.
    expect(
      commentsApiFor({ commentsApiUrl: "https://review.example", commentsApiKey: "sk-shared" }),
    ).toEqual({ apiUrl: "https://review.example", apiKey: "sk-shared" });
  });

  it("tells an unconfigured machine to log in, not to find a key it cannot have", () => {
    // The old message named `commentsApiKey`, which no Cloud creator can obtain.
    expect(() => commentsApiFor({})).toThrow(/forge login/);
    expect(() => commentsApiFor({ commentsApiUrl: "https://review.example" })).toThrow(
      /forge login/,
    );
  });
});
