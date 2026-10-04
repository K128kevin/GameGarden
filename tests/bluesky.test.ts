/**
 * Bluesky discovery: recent posts only, top-level conversations, and hashtag top-up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type SearchParams = { q: string; sort: string; since: string; limit: number };
const searches: SearchParams[] = [];
let results: (p: SearchParams) => unknown[] = () => [];

vi.mock("@atproto/api", async (importActual) => {
  const actual = await importActual<typeof import("@atproto/api")>();
  class AtpAgent {
    login = async () => ({});
    app = {
      bsky: {
        feed: {
          searchPosts: async (p: SearchParams) => {
            searches.push(p);
            return { data: { posts: results(p) } };
          },
        },
      },
    };
  }
  return { ...actual, AtpAgent };
});

import { bluesky, DISCOVER_DAYS } from "@/platforms/bluesky";
import type { AccountContext } from "@/platforms/types";

const DAY = 86_400_000;
let n = 0;
function post(opts: { daysAgo: number; reply?: boolean; did?: string; text?: string }) {
  const id = `p${++n}`;
  const createdAt = new Date(Date.now() - opts.daysAgo * DAY).toISOString();
  return {
    uri: `at://${opts.did ?? "did:other"}/app.bsky.feed.post/${id}`,
    cid: `cid-${id}`,
    author: { did: opts.did ?? "did:other", handle: "other.test" },
    record: {
      $type: "app.bsky.feed.post",
      text: opts.text ?? id,
      createdAt,
      ...(opts.reply ? { reply: { root: { uri: "at://x/app.bsky.feed.post/r", cid: "c" }, parent: { uri: "at://x/app.bsky.feed.post/r", cid: "c" } } } : {}),
    },
    indexedAt: new Date().toISOString(),
    likeCount: 3,
  };
}

function ctx(): AccountContext {
  return {
    account: { id: "a1", externalId: "did:me", handle: "me.test" },
    credentials: { service: "https://bsky.test", identifier: "me.test", appPassword: "x" },
  } as unknown as AccountContext;
}

beforeEach(() => {
  searches.length = 0;
});

describe("Bluesky discovery", () => {
  it("only searches the last few days, mixing top and latest", async () => {
    results = () => [post({ daysAgo: 0.5 })];
    await bluesky.discover(ctx(), { keywords: ["#pixelart"], communities: [], limit: 15 });
    const sinceMs = new Date(searches[0].since).getTime();
    expect(Math.abs(Date.now() - DISCOVER_DAYS * DAY - sinceMs)).toBeLessThan(60_000);
    expect(searches.filter((s) => s.q === "#pixelart").map((s) => s.sort)).toEqual(["top", "latest"]);
    expect(searches.every((s) => s.since === searches[0].since)).toBe(true);
  });

  it("drops backdated posts, replies and the user's own posts", async () => {
    const hits = [post({ daysAgo: 400, text: "backdated" }), post({ daysAgo: 1, reply: true, text: "a reply" }), post({ daysAgo: 1, did: "did:me", text: "mine" }), post({ daysAgo: 1, text: "keep" })];
    results = (p) => (p.q === "roguelike" ? hits : []); // top and latest return the same post: kept once
    const found = await bluesky.discover(ctx(), { keywords: ["roguelike"], communities: [], limit: 15 });
    expect(found.map((d) => d.text)).toEqual(["keep"]);
    expect(found[0].createdAt.getTime()).toBeGreaterThan(Date.now() - 2 * DAY);
  });

  it("tops up from indie dev hashtags when the plan's own queries come back thin", async () => {
    results = (p) => (p.q.startsWith("#") ? Array.from({ length: 10 }, () => post({ daysAgo: 1 })) : []);
    const found = await bluesky.discover(ctx(), { keywords: ["very specific phrase nobody uses"], communities: [], limit: 15 });
    expect(found).toHaveLength(15);
    expect(new Set(found.map((d) => d.matchedQuery))).toEqual(new Set(["#indiedev", "#gamedev"]));
  });
});
