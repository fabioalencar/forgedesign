import { describe, expect, it } from "vitest";
import { parseWindowDeadline } from "../src/commands/comments.js";

// The feedback window's date parsing (TASK-387).
//
// Pure, and tested on its own because it is the half that fails *silently*: a
// deadline off by most of a day still looks like a deadline, and the reviewer
// who loses those hours is the one person who cannot see that it happened.

const NOW = new Date("2026-08-26T12:00:00Z");

describe("parseWindowDeadline", () => {
  it("reads a bare date as the end of that day where the creator is", () => {
    // "Closes 4 September" means the 4th is still a day you can comment on.
    // JavaScript reads a date-only string as UTC *midnight*, which would close
    // the round almost a day early for anyone west of Greenwich — the exact
    // silent timezone bug this feature exists to prevent.
    const iso = parseWindowDeadline("2026-09-04", NOW);
    const local = new Date(iso);
    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(8);
    expect(local.getDate()).toBe(4);
    expect(local.getHours()).toBe(23);
    expect(local.getMinutes()).toBe(59);
    // Never UTC midnight of that day, which is what `new Date("2026-09-04")` is.
    expect(iso).not.toBe("2026-09-04T00:00:00.000Z");
  });

  it("keeps a date and time as the instant it names", () => {
    const iso = parseWindowDeadline("2026-09-04T18:30", NOW);
    expect(new Date(iso).getHours()).toBe(18);
    expect(new Date(iso).getMinutes()).toBe(30);
  });

  it("accepts an explicit UTC instant unchanged", () => {
    expect(parseWindowDeadline("2026-09-04T18:30:00Z", NOW)).toBe("2026-09-04T18:30:00.000Z");
  });

  it("refuses something that is not a date rather than storing a guess", () => {
    expect(() => parseWindowDeadline("next Friday", NOW)).toThrow(/not a date/);
  });

  it("refuses a deadline in the past, and names the command that ends a round now", () => {
    // Almost always a typo — and accepting it would close the round on the spot,
    // which is a thing you should have to ask for.
    expect(() => parseWindowDeadline("2026-08-01", NOW)).toThrow(/in the past/);
    expect(() => parseWindowDeadline("2026-08-01", NOW)).toThrow(/forge comments archive/);
  });
});
