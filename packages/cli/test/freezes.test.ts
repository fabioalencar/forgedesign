import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localIsoDate, todayIsoDate } from "../src/freezes.js";

describe("record dates are the creator's calendar day (TASK-534)", () => {
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
    // Three hours west of UTC, no daylight saving: the creator's own zone.
    process.env.TZ = "America/Sao_Paulo";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it("dates a freeze cut at 21:30 local on that day, not on UTC's tomorrow", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T00:30:00Z")); // 21:30 on the 12th in São Paulo

    expect(todayIsoDate()).toBe("2026-10-12");
  });

  it("dates an instant from the service by where the creator is", () => {
    expect(localIsoDate(new Date("2026-10-13T02:59:59Z"))).toBe("2026-10-12");
    expect(localIsoDate(new Date("2026-10-13T03:00:00Z"))).toBe("2026-10-13");
    expect(localIsoDate(new Date("2026-01-05T12:00:00Z"))).toBe("2026-01-05");
  });
});
