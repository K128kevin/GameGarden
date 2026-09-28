import { describe, expect, it } from "vitest";
import { cleanDraft, stripDashes } from "@/lib/drafts";

describe("stripDashes", () => {
  it("turns em and en dashes into commas", () => {
    expect(stripDashes("Finally fixed the dash — it feels so much snappier now")).toBe(
      "Finally fixed the dash, it feels so much snappier now",
    );
    expect(stripDashes("Pixel art—hand drawn—at 12fps")).toBe("Pixel art, hand drawn, at 12fps");
    expect(stripDashes("New build – come try it")).toBe("New build, come try it");
  });

  it("keeps number ranges readable", () => {
    expect(stripDashes("Playtests run 3–5 PM, 2026—2027 roadmap")).toBe("Playtests run 3-5 PM, 2026-2027 roadmap");
  });

  it("cleans up leftover punctuation", () => {
    expect(stripDashes("Wait for it —")).toBe("Wait for it");
    expect(stripDashes("So close —!")).toBe("So close!");
    expect(stripDashes("(mostly — kind of) done")).toBe("(mostly, kind of) done");
    expect(stripDashes("— first thing\n— second thing")).toBe("- first thing\n- second thing");
  });

  it("leaves normal text and hyphens alone", () => {
    const t = "A cozy roguelite, hand-drawn at 12fps. Demo out Feb 3!";
    expect(stripDashes(t)).toBe(t);
  });

  it("cleanDraft returns null for empty drafts", () => {
    expect(cleanDraft("")).toBeNull();
    expect(cleanDraft(null)).toBeNull();
    expect(cleanDraft(" — ")).toBeNull();
  });
});
