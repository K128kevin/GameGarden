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

type YtCreds = { accessToken: string; refreshToken?: string; expiresAt: number };

const API = "https://www.googleapis.com/youtube/v3";
const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];

const clientId = () => process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";
const clientSecret = () => process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "";

async function tokenRequest(params: Record<string, string>) {
  const body = new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params });
  return fetchJson<{ access_token: string; refresh_token?: string; expires_in: number }>(
    "https://oauth2.googleapis.com/token",
    { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" }, errorPrefix: "Google token exchange failed" },
  );
}

async function accessToken(ctx: AccountContext): Promise<string> {
  const c = ctx.credentials as YtCreds;
  if (c.expiresAt > Date.now() + 60_000) return c.accessToken;
  if (!c.refreshToken) throw new PlatformError("YouTube session expired; please reconnect.", true);
  let t;
  try {
    t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refreshToken });
  } catch (e) {
    throw new PlatformError(`YouTube token refresh failed: ${(e as Error).message}`, true);
  }
  const next: YtCreds = { accessToken: t.access_token, refreshToken: t.refresh_token ?? c.refreshToken, expiresAt: Date.now() + t.expires_in * 1000 };
  ctx.credentials = next;
  await ctx.saveCredentials(next);
  return next.accessToken;
}

async function yt<T>(ctx: AccountContext, path: string, params: Record<string, string | number>, init?: RequestInit): Promise<T> {
  const token = await accessToken(ctx);
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return fetchJson<T>(`${API}/${path}?${qs}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    errorPrefix: `YouTube ${path}`,
  });
}

type Channel = {
  id: string;
  snippet: { title: string; customUrl?: string; description?: string; thumbnails?: { default?: { url: string } } };
  statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
};
type Video = {
  id: string;
  snippet: { title: string; description: string; publishedAt: string; channelId: string; channelTitle: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
};

const n = (v?: string) => (v ? Number(v) : 0);

function videoToOwn(v: Video): OwnContent {
  return {
    externalId: v.id,
    kind: "video",
    url: `https://www.youtube.com/watch?v=${v.id}`,
    title: v.snippet.title,
    text: truncate(v.snippet.description, 1000),
    publishedAt: new Date(v.snippet.publishedAt),
    metrics: { views: n(v.statistics?.viewCount), likes: n(v.statistics?.likeCount), comments: n(v.statistics?.commentCount) },
  };
}

async function myChannel(ctx: AccountContext): Promise<Channel> {
  const r = await yt<{ items?: Channel[] }>(ctx, "channels", { part: "snippet,statistics,contentDetails", mine: "true" });
  const ch = r.items?.[0];
  if (!ch) throw new PlatformError("No YouTube channel found for this Google account.");
  return ch;
}

async function videosById(ctx: AccountContext, ids: string[]): Promise<Video[]> {
  if (!ids.length) return [];
  const r = await yt<{ items?: Video[] }>(ctx, "videos", { part: "snippet,statistics", id: ids.slice(0, 50).join(",") });
  return r.items ?? [];
}

export function youtubeVideoId(url: string): string | null {
  const m =
    url.match(/[?&]v=([\w-]{11})/) ?? url.match(/youtu\.be\/([\w-]{11})/) ?? url.match(/\/(?:shorts|live|embed)\/([\w-]{11})/);
  return m ? m[1] : null;
}

export const youtube: PlatformConnector = {
  id: "youtube",
  name: "YouTube",
  badgeClass: "bg-red-500/15 text-red-300 ring-red-500/30",
  description: "Connect a YouTube channel with Google OAuth to track videos, comments, and reply from GameGarden.",
  capabilities: {
    post: false,
    reply: true,
    maxLength: 10000,
    notes:
      "GameGarden can comment on videos and reply to comments. Uploading videos and Community posts is not available via the API, so video/Short ideas are delivered as manual tasks with drafted titles and descriptions.",
  },
  isConfigured: () => Boolean(clientId() && clientSecret()),
  configHelp: "Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (or YOUTUBE_CLIENT_ID/SECRET) and enable the YouTube Data API v3.",

  connect: {
    type: "oauth",
    getAuthorizationUrl({ state, redirectUri }) {
      const qs = new URLSearchParams({
        client_id: clientId(),
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${qs}`;
    },
    async exchangeCode({ code, redirectUri }) {
      const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
      const creds: YtCreds = { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 };
      const ctx: AccountContext = {
        account: { id: "", externalId: "", handle: "" },
        credentials: creds,
        saveCredentials: async () => {},
      };
      const ch = await myChannel(ctx);
      return {
        externalId: ch.id,
        handle: ch.snippet.customUrl ?? ch.snippet.title,
        displayName: ch.snippet.title,
        avatarUrl: ch.snippet.thumbnails?.default?.url ?? null,
        profileUrl: ch.snippet.customUrl ? `https://www.youtube.com/${ch.snippet.customUrl}` : `https://www.youtube.com/channel/${ch.id}`,
        credentials: ctx.credentials,
      };
    },
  },

  async fetchProfile(ctx) {
    const ch = await myChannel(ctx);
    return {
      followers: n(ch.statistics?.subscriberCount),
      postsCount: n(ch.statistics?.videoCount),
      extra: { totalViews: n(ch.statistics?.viewCount), description: truncate(ch.snippet.description, 500) },
    };
  },

  async fetchOwnContent(ctx, { limit }) {
    const ch = await myChannel(ctx);
    const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];
    const items = await yt<{ items?: { contentDetails: { videoId: string } }[] }>(ctx, "playlistItems", {
      part: "contentDetails",
      playlistId: uploads,
      maxResults: Math.min(limit, 50),
    });
    const vids = await videosById(ctx, (items.items ?? []).map((i) => i.contentDetails.videoId));
    return vids.map(videoToOwn);
  },

  async fetchInteractions(ctx, { limit }) {
    type Thread = {
      id: string;
      snippet: {
        videoId?: string;
        totalReplyCount: number;
        topLevelComment: {
          id: string;
          snippet: { authorDisplayName: string; authorChannelId?: { value: string }; textOriginal: string; publishedAt: string };
        };
      };
      replies?: { comments?: { snippet: { authorChannelId?: { value: string } } }[] };
    };
    // "replies" returns up to 5 replies per thread at no extra quota cost; used to spot threads you already answered.
    const r = await yt<{ items?: Thread[] }>(ctx, "commentThreads", {
      part: "snippet,replies",
      allThreadsRelatedToChannelId: ctx.account.externalId,
      maxResults: Math.min(limit, 100),
      order: "time",
    });
    const out: InboundInteraction[] = [];
    for (const t of r.items ?? []) {
      const c = t.snippet.topLevelComment.snippet;
      if (c.authorChannelId?.value === ctx.account.externalId) continue;
      out.push({
        externalId: t.snippet.topLevelComment.id,
        kind: "comment",
        authorHandle: c.authorDisplayName,
        text: truncate(c.textOriginal, 800),
        url: t.snippet.videoId ? `https://www.youtube.com/watch?v=${t.snippet.videoId}&lc=${t.snippet.topLevelComment.id}` : null,
        onExternalId: t.snippet.videoId ?? null,
        replyTarget: { parentId: t.snippet.topLevelComment.id },
        occurredAt: new Date(c.publishedAt),
        alreadyReplied: (t.replies?.comments ?? []).some((rc) => rc.snippet.authorChannelId?.value === ctx.account.externalId),
      });
    }
    return out;
  },

  async discover(ctx, { keywords, limit }) {
    // search.list costs 100 quota units per call (daily quota is 10,000), so keep this small.
    const out: DiscoveredPost[] = [];
    const publishedAfter = new Date(Date.now() - 14 * 86_400_000).toISOString();
    for (const q of keywords.slice(0, 2)) {
      try {
        const r = await yt<{ items?: { id: { videoId: string } }[] }>(ctx, "search", {
          part: "id",
          type: "video",
          q,
          order: "relevance",
          publishedAfter,
          maxResults: Math.min(limit, 10),
        });
        const vids = await videosById(ctx, (r.items ?? []).map((i) => i.id.videoId));
        for (const v of vids) {
          if (v.snippet.channelId === ctx.account.externalId) continue;
          out.push({
            externalId: v.id,
            url: `https://www.youtube.com/watch?v=${v.id}`,
            authorHandle: v.snippet.channelTitle,
            title: v.snippet.title,
            text: truncate(v.snippet.description, 400),
            createdAt: new Date(v.snippet.publishedAt),
            metrics: { views: n(v.statistics?.viewCount), likes: n(v.statistics?.likeCount), comments: n(v.statistics?.commentCount) },
            replyTarget: { videoId: v.id },
            matchedQuery: q,
          });
        }
      } catch {
        // Quota exhaustion etc. — discovery is best-effort.
      }
    }
    return out.slice(0, limit);
  },

  matchesUrl: (url) => /^https?:\/\/((www|m)\.)?(youtube\.com|youtu\.be)\//i.test(url),

  async resolveOwnContentUrl(ctx, url) {
    const id = youtubeVideoId(url);
    if (!id) return null;
    const [v] = await videosById(ctx, [id]);
    if (!v || v.snippet.channelId !== ctx.account.externalId) return null;
    return videoToOwn(v);
  },

  async publish(ctx, payload: PublishPayload) {
    if (payload.kind !== "reply") throw new PlatformError("YouTube only supports comments and replies from GameGarden.");
    const t = (payload.target?.data ?? {}) as { parentId?: string; videoId?: string };
    const text = payload.text.trim();
    if (t.parentId) {
      const r = await yt<{ id: string }>(ctx, "comments", { part: "snippet" }, {
        method: "POST",
        body: JSON.stringify({ snippet: { parentId: t.parentId, textOriginal: text } }),
      });
      return { externalId: r.id, url: payload.target?.url ?? null, kind: "comment" };
    }
    if (t.videoId) {
      const r = await yt<{ id: string }>(ctx, "commentThreads", { part: "snippet" }, {
        method: "POST",
        body: JSON.stringify({ snippet: { videoId: t.videoId, topLevelComment: { snippet: { textOriginal: text } } } }),
      });
      return { externalId: r.id, url: `https://www.youtube.com/watch?v=${t.videoId}&lc=${r.id}`, kind: "comment" };
    }
    throw new PlatformError("Missing YouTube reply target.");
  },
};
