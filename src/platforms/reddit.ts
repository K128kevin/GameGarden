import type { PublishPayload } from "@/db/schema";
import {
  PlatformError,
  fetchJson,
  truncate,
  type AccountContext,
  type DiscoveredPost,
  type InboundInteraction,
  type OwnContent,
  type PlatformConnector,
} from "./types";

type RedditCreds = { accessToken: string; refreshToken?: string; expiresAt: number };

const SCOPES = ["identity", "read", "submit", "history", "privatemessages", "mysubreddits"];
const clientId = () => process.env.REDDIT_CLIENT_ID || "";
const clientSecret = () => process.env.REDDIT_CLIENT_SECRET || "";
const userAgent = () => process.env.REDDIT_USER_AGENT || "web:gamegarden:v0.1 (indie game marketing assistant)";

async function tokenRequest(params: Record<string, string>) {
  const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");
  return fetchJson<{ access_token: string; refresh_token?: string; expires_in: number; error?: string }>(
    "https://www.reddit.com/api/v1/access_token",
    {
      method: "POST",
      body: new URLSearchParams(params),
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": userAgent(),
      },
      errorPrefix: "Reddit token request failed",
    },
  );
}

async function accessToken(ctx: AccountContext): Promise<string> {
  const c = ctx.credentials as RedditCreds;
  if (c.expiresAt > Date.now() + 60_000) return c.accessToken;
  if (!c.refreshToken) throw new PlatformError("Reddit session expired; please reconnect.", true);
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refreshToken }).catch((e) => {
    throw new PlatformError(`Reddit token refresh failed: ${(e as Error).message}`, true);
  });
  if (t.error) throw new PlatformError(`Reddit token refresh failed: ${t.error}`, true);
  const next: RedditCreds = { accessToken: t.access_token, refreshToken: t.refresh_token ?? c.refreshToken, expiresAt: Date.now() + t.expires_in * 1000 };
  ctx.credentials = next;
  await ctx.saveCredentials(next);
  return next.accessToken;
}

async function rd<T>(ctx: AccountContext, path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken(ctx);
  return fetchJson<T>(`https://oauth.reddit.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "user-agent": userAgent(), ...(init?.headers ?? {}) },
    errorPrefix: `Reddit ${path.split("?")[0]}`,
  });
}

type Thing<T> = { kind: string; data: T };
type Listing<T> = { data: { children: Thing<T>[] } };
type RPost = {
  name: string;
  id: string;
  title?: string;
  selftext?: string;
  body?: string;
  subreddit: string;
  permalink: string;
  created_utc: number;
  score: number;
  num_comments?: number;
  upvote_ratio?: number;
  author: string;
  link_id?: string;
  parent_id?: string;
  stickied?: boolean;
  over_18?: boolean;
};

function toOwn(t: Thing<RPost>): OwnContent {
  const d = t.data;
  const isComment = t.kind === "t1";
  return {
    externalId: d.name,
    kind: isComment ? "comment" : "post",
    url: `https://www.reddit.com${d.permalink}`,
    title: d.title ?? null,
    text: truncate(isComment ? d.body : d.selftext, 1500),
    community: d.subreddit,
    parentExternalId: isComment ? (d.parent_id ?? null) : null,
    publishedAt: new Date(d.created_utc * 1000),
    metrics: { score: d.score, comments: d.num_comments ?? 0, ...(d.upvote_ratio != null ? { upvoteRatioPct: Math.round(d.upvote_ratio * 100) } : {}) },
  };
}

export function normalizeSubreddit(s: string) {
  return s.trim().replace(/^\/?r\//i, "").replace(/[^\w]/g, "");
}

export const reddit: PlatformConnector = {
  id: "reddit",
  name: "Reddit",
  badgeClass: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  description: "Connect a Reddit account with OAuth to track posts/comments, find threads, and post or reply.",
  capabilities: {
    post: true,
    reply: true,
    requiresTitle: true,
    requiresCommunity: true,
    communityLabel: "Subreddit",
    maxLength: 40000,
    notes:
      "Each subreddit has its own self-promotion rules (many require a 9:1 participation ratio or a specific flair/day). Posts need a title and a subreddit.",
  },
  isConfigured: () => Boolean(clientId() && clientSecret()),
  configHelp: "Create a 'web app' at https://www.reddit.com/prefs/apps and set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and REDDIT_USER_AGENT.",

  connect: {
    type: "oauth",
    getAuthorizationUrl({ state, redirectUri }) {
      const qs = new URLSearchParams({
        client_id: clientId(),
        response_type: "code",
        state,
        redirect_uri: redirectUri,
        duration: "permanent",
        scope: SCOPES.join(" "),
      });
      return `https://www.reddit.com/api/v1/authorize?${qs}`;
    },
    async exchangeCode({ code, redirectUri }) {
      const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
      if (t.error) throw new PlatformError(`Reddit authorization failed: ${t.error}`);
      const creds: RedditCreds = { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 };
      const ctx: AccountContext = { account: { id: "", externalId: "", handle: "" }, credentials: creds, saveCredentials: async () => {} };
      const me = await rd<{ id: string; name: string; icon_img?: string; subreddit?: { display_name_prefixed?: string } }>(ctx, "/api/v1/me");
      return {
        externalId: me.id,
        handle: me.name,
        displayName: `u/${me.name}`,
        avatarUrl: me.icon_img?.split("?")[0] ?? null,
        profileUrl: `https://www.reddit.com/user/${me.name}`,
        credentials: ctx.credentials,
      };
    },
  },

  async fetchProfile(ctx) {
    const me = await rd<{
      total_karma?: number;
      link_karma?: number;
      comment_karma?: number;
      created_utc?: number;
      subreddit?: { subscribers?: number };
    }>(ctx, "/api/v1/me");
    return {
      followers: me.subreddit?.subscribers ?? null,
      extra: {
        totalKarma: me.total_karma ?? 0,
        linkKarma: me.link_karma ?? 0,
        commentKarma: me.comment_karma ?? 0,
        accountAgeDays: me.created_utc ? Math.floor((Date.now() / 1000 - me.created_utc) / 86400) : null,
      },
    };
  },

  async fetchOwnContent(ctx, { limit }) {
    const l = await rd<Listing<RPost>>(ctx, `/user/${encodeURIComponent(ctx.account.handle)}/overview?limit=${Math.min(limit, 100)}&raw_json=1`);
    return l.data.children.filter((c) => c.kind === "t1" || c.kind === "t3").map(toOwn);
  },

  async fetchInteractions(ctx, { limit }) {
    type Msg = { name: string; author: string; body: string; context?: string; created_utc: number; type?: string; was_comment: boolean; parent_id?: string; subreddit?: string };
    const l = await rd<Listing<Msg>>(ctx, `/message/inbox?limit=${Math.min(limit, 100)}&raw_json=1`);
    const out: InboundInteraction[] = [];
    for (const c of l.data.children) {
      const m = c.data;
      if (!m.was_comment) continue; // skip private messages
      out.push({
        externalId: m.name,
        kind: m.type === "username_mention" ? "mention" : "reply",
        authorHandle: m.author,
        text: truncate(m.body, 800),
        url: m.context ? `https://www.reddit.com${m.context}` : null,
        onExternalId: m.parent_id ?? null,
        replyTarget: { thingId: m.name },
        occurredAt: new Date(m.created_utc * 1000),
      });
    }
    return out;
  },

  async discover(ctx, { keywords, communities, limit }) {
    const out: DiscoveredPost[] = [];
    const subs = communities.map(normalizeSubreddit).filter(Boolean).slice(0, 5);
    const per = Math.max(4, Math.ceil(limit / Math.max(subs.length, 1)));
    const push = (t: Thing<RPost>, matchedQuery: string) => {
      const d = t.data;
      if (d.stickied || d.over_18 || d.author === ctx.account.handle) return;
      if (out.some((o) => o.externalId === d.name)) return;
      out.push({
        externalId: d.name,
        url: `https://www.reddit.com${d.permalink}`,
        authorHandle: d.author,
        title: d.title ?? null,
        text: truncate(d.selftext, 500),
        community: d.subreddit,
        createdAt: new Date(d.created_utc * 1000),
        metrics: { score: d.score, comments: d.num_comments ?? 0 },
        replyTarget: { thingId: d.name },
        matchedQuery,
      });
    };
    for (const sub of subs) {
      try {
        const l = await rd<Listing<RPost>>(ctx, `/r/${sub}/hot?limit=${per + 2}&raw_json=1`);
        l.data.children.filter((c) => c.kind === "t3").forEach((c) => push(c, `r/${sub}`));
      } catch {
        // Private/banned subreddit etc.
      }
    }
    for (const q of keywords.slice(0, 2)) {
      try {
        const l = await rd<Listing<RPost>>(ctx, `/search?q=${encodeURIComponent(q)}&sort=new&t=week&limit=${per}&type=link&raw_json=1`);
        l.data.children.filter((c) => c.kind === "t3").forEach((c) => push(c, q));
      } catch {
        // best-effort
      }
    }
    return out.slice(0, limit);
  },

  matchesUrl: (url) => /^https?:\/\/((www|old|new|np)\.)?reddit\.com\/|^https?:\/\/redd\.it\//i.test(url),

  async resolveOwnContentUrl(ctx, url) {
    const comment = url.match(/\/comments\/(\w+)\/[^/]*\/(\w+)/);
    const post = url.match(/\/comments\/(\w+)/) ?? url.match(/redd\.it\/(\w+)/);
    const fullname = comment ? `t1_${comment[2]}` : post ? `t3_${post[1]}` : null;
    if (!fullname) return null;
    const l = await rd<Listing<RPost>>(ctx, `/api/info?id=${fullname}&raw_json=1`);
    const t = l.data.children[0];
    if (!t || t.data.author.toLowerCase() !== ctx.account.handle.toLowerCase()) return null;
    return toOwn(t);
  },

  async publish(ctx, payload: PublishPayload) {
    type JsonResp = { json: { errors: [string, string, string][]; data?: { things?: Thing<RPost>[]; url?: string; name?: string; id?: string } } };
    const check = (r: JsonResp) => {
      if (r.json.errors?.length) throw new PlatformError(`Reddit rejected the submission: ${r.json.errors.map((e) => e.slice(0, 2).join(" ")).join("; ")}`);
    };
    if (payload.kind === "reply") {
      const thingId = (payload.target?.data as { thingId?: string } | undefined)?.thingId ?? payload.target?.externalId;
      if (!thingId) throw new PlatformError("Missing Reddit reply target.");
      const r = await rd<JsonResp>(ctx, "/api/comment", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ api_type: "json", thing_id: thingId, text: payload.text }),
      });
      check(r);
      const thing = r.json.data?.things?.[0];
      return {
        externalId: thing?.data.name ?? "",
        url: thing ? `https://www.reddit.com${thing.data.permalink}` : null,
        kind: "comment",
      };
    }
    const sr = normalizeSubreddit(payload.community ?? "");
    if (!sr) throw new PlatformError("Reddit posts need a subreddit.");
    if (!payload.title?.trim()) throw new PlatformError("Reddit posts need a title.");
    const params = new URLSearchParams({ api_type: "json", sr, title: payload.title.trim(), resubmit: "true" });
    if (payload.link && !payload.text.trim()) {
      params.set("kind", "link");
      params.set("url", payload.link);
    } else {
      params.set("kind", "self");
      params.set("text", payload.link && !payload.text.includes(payload.link) ? `${payload.text}\n\n${payload.link}` : payload.text);
    }
    const r = await rd<JsonResp>(ctx, "/api/submit", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
    });
    check(r);
    return { externalId: r.json.data?.name ?? "", url: r.json.data?.url ?? null, kind: "post" };
  },
};
