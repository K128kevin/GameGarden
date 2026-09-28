import { describe, expect, it } from "vitest";
import { currentPlanSlot, nextPlanSlot, parseLocalInput, toLocalInput, zonedToUtc } from "@/lib/time";

describe("time helpers", () => {
  it("converts New York wall time to UTC across DST", () => {
    expect(zonedToUtc(2026, 7, 1, 9, 0, "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z"); // EDT
    expect(zonedToUtc(2026, 12, 1, 9, 0, "America/New_York").toISOString()).toBe("2026-12-01T14:00:00.000Z"); // EST
  });

  it("round-trips datetime-local values", () => {
    const d = parseLocalInput("2026-09-28T18:30", "America/Los_Angeles")!;
    expect(d.toISOString()).toBe("2026-09-29T01:30:00.000Z");
    expect(toLocalInput(d, "America/Los_Angeles")).toBe("2026-09-28T18:30");
  });

  it("finds the current 9am/9pm ET slot", () => {
    // 10:15 EDT → morning slot
    expect(currentPlanSlot(new Date("2026-09-28T14:15:00Z")).id).toBe("2026-09-28-am");
    // 08:59 EDT → previous evening
    expect(currentPlanSlot(new Date("2026-09-28T12:59:00Z")).id).toBe("2026-09-27-pm");
    // 21:00 EDT exactly
    expect(currentPlanSlot(new Date("2026-09-29T01:00:00Z")).id).toBe("2026-09-28-pm");
    // Winter: 9:30 EST = 14:30 UTC
    expect(currentPlanSlot(new Date("2026-12-15T14:30:00Z")).id).toBe("2026-12-15-am");
    expect(currentPlanSlot(new Date("2026-12-15T13:30:00Z")).id).toBe("2026-12-14-pm");
  });

  it("computes the next slot", () => {
    expect(nextPlanSlot(new Date("2026-09-28T14:15:00Z")).toISOString()).toBe("2026-09-29T01:00:00.000Z");
    expect(nextPlanSlot(new Date("2026-09-29T01:30:00Z")).toISOString()).toBe("2026-09-29T13:00:00.000Z");
    // Across the Nov 1 2026 DST change: 9pm EDT Oct 31 → 9am EST Nov 1 = 14:00Z
    expect(nextPlanSlot(new Date("2026-11-01T02:00:00Z")).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });
});

import { normalizeOutput, PlanOutput } from "@/services/ai";

describe("model output normalization", () => {
  it("coerces unknown enum values instead of failing", () => {
    const raw = {
      assessment: "a",
      strategyChanged: false,
      strategyChangeSummary: "",
      strategy: "s",
      focusKeywords: ["x"],
      recommendations: [{ kind: "Thread", accountRef: "A1", title: "t", rationale: "r", priority: "urgent", suggestedTime: "2026-01-01T00:00:00Z" }],
    };
    const parsed = PlanOutput.parse(normalizeOutput(raw));
    expect(parsed.recommendations[0].kind).toBe("other");
    expect(parsed.recommendations[0].priority).toBe("medium");
    expect(parsed.completedRefs).toEqual([]);
  });
});
