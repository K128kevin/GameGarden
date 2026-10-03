import { AtpAgent, RichText, AppBskyFeedPost, AppBskyFeedDefs } from "@atproto/api";
import type { PublishPayload } from "@/db/schema";
import {
  PlatformError,
  truncate,
  type AccountContext,
  type DiscoveredPost,
  type InboundInteraction,
  type OwnContent,
  type PlatformConnector,
} from "./types";

type BskyCreds = { service: string; identifier: string; appPassword: string };

const DEFAULT_SERVICE = "https://bsky.social";

// One login per account context (a sync makes several calls; createSession is rate-limited).
const agents = new WeakMap<AccountContext, Promise<AtpAgent>>();

function agentFor(ctx: AccountContext): Promise<AtpAgent> {
  let p = agents.get(ctx);
  if (!p) {
    p = login(ctx);
    p.catch(() => agents.delete(ctx));
    agents.set(ctx, p);
  }
  return p;
}

async function login(ctx: AccountContext): Promise<AtpAgent> {
  const c = ctx.credentials as BskyCreds;
  const agent = new AtpAgent({ service: c.service || DEFAULT_SERVICE });
  try {
    await agent.login({ identifier: c.identifier, password: c.appPassword });
  } catch (e) {
    throw new PlatformError(`Bluesky login failed: ${(e as Error).message}`, true);
  }
  return agent;
}

function rkey(uri: string) {
  return uri.split("/").pop() ?? "";
}

export function bskyPostUrl(handleOrDid: string, uri: string) {
  return `https://bsky.app/profile/${handleOrDid}/post/${rkey(uri)}`;
}

function postText(record: unknown): string {
  return AppBskyFeedPost.isRecord(record) ? ((record as AppBskyFeedPost.Record).text ?? "") : "";
}

function replyRefs(record: unknown): { root?: { uri: string; cid: string }; parent?: { uri: string; cid: string } } {
  if (!AppBskyFeedPost.isRecord(record)) return {};
  const r = (record as AppBskyFeedPost.Record).reply;
  return r ? { root: { uri: r.root.uri, cid: r.root.cid }, parent: { uri: r.parent.uri, cid: r.parent.cid } } : {};
}

function toOwn(post: AppBskyFeedDefs.PostView): OwnContent {
  const refs = replyRefs(post.record);
  const created = (post.record as { createdAt?: string }).createdAt ?? post.indexedAt;
  return {
    externalId: post.uri,
    kind: refs.parent ? "reply" : "post",
    url: bskyPostUrl(post.author.handle, post.uri),
    text: postText(post.record),
    parentExternalId: refs.parent?.uri ?? null,
    publishedAt: new Date(created),
    metrics: {
      likes: post.likeCount ?? 0,
      reposts: post.repostCount ?? 0,
      replies: post.replyCount ?? 0,
      quotes: post.quoteCount ?? 0,
    },
  };
}

/** Target data needed to reply to a post. */
function replyTargetFor(uri: string, cid: string, record: unknown) {
  const refs = replyRefs(record);
  return { uri, cid, rootUri: refs.root?.uri ?? uri, rootCid: refs.root?.cid ?? cid };
}

export const bluesky: PlatformConnector = {
  id: "bluesky",
  name: "Bluesky",
  badgeClass: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  description: "Connect with your handle and an app password (Settings → Privacy and security → App passwords).",
  capabilities: {
    post: true,
    reply: true,
    like: true,
    follow: true,
    followLabel: "Follow",
    followByHandle: true,
    maxLength: 300,
    notes: "Posts are limited to 300 characters. Hashtags and links are auto-detected.",
  },
  isConfigured: () => true,
  configHelp: "No server configuration needed.",

  connect: {
    type: "credentials",
    fields: [
      { name: "identifier", label: "Handle or email", type: "text", placeholder: "you.bsky.social", required: true },
      {
        name: "appPassword",
        label: "App password",
        type: "password",
        placeholder: "xxxx-xxxx-xxxx-xxxx",
        help: "Create one at bsky.app → Settings → Privacy and security → App passwords. Never use your main password.",
        required: true,
      },
      {
        name: "service",
        label: "PDS / service URL (optional)",
        type: "url",
        placeholder: DEFAULT_SERVICE,
      },
    ],
    async connectWithCredentials(values) {
      const creds: BskyCreds = {
        service: values.service?.trim() || DEFAULT_SERVICE,
        identifier: values.identifier.trim().replace(/^@/, ""),
        appPassword: values.appPassword.trim(),
      };
      const agent = new AtpAgent({ service: creds.service });
      try {
        await agent.login({ identifier: creds.identifier, password: creds.appPassword });
      } catch (e) {
        throw new PlatformError(`Bluesky login failed: ${(e as Error).message}`);
      }
      const did = agent.session!.did;
      const profile = await agent.getProfile({ actor: did });
      return {
        externalId: did,
        handle: profile.data.handle,
        displayName: profile.data.displayName ?? null,
        avatarUrl: profile.data.avatar ?? null,
        profileUrl: `https://bsky.app/profile/${profile.data.handle}`,
        credentials: creds,
      };
    },
  },

  async fetchProfile(ctx) {
    const agent = await agentFor(ctx);
    const { data } = await agent.getProfile({ actor: ctx.account.externalId });
    return {
      followers: data.followersCount ?? null,
      following: data.followsCount ?? null,
      postsCount: data.postsCount ?? null,
      extra: { description: data.description ?? "", handle: data.handle },
    };
  },

  async fetchOwnContent(ctx, { limit }) {
    const agent = await agentFor(ctx);
    const { data } = await agent.getAuthorFeed({
      actor: ctx.account.externalId,
      limit: Math.min(limit, 100),
      filter: "posts_with_replies",
    });
    return data.feed
      .filter((f) => f.post.author.did === ctx.account.externalId && !f.reason) // skip reposts
      .map((f) => toOwn(f.post));
  },

  async fetchInteractions(ctx, { limit }) {
    const agent = await agentFor(ctx);
    const { data } = await agent.listNotifications({ limit: Math.min(limit, 100) });
    const out: InboundInteraction[] = [];
    for (const n of data.notifications) {
      const kind = ({ reply: "reply", mention: "mention", quote: "quote", follow: "follow", like: "like" } as const)[
        n.reason as "reply" | "mention" | "quote" | "follow" | "like"
      ];
      if (!kind) continue;
      const replyable = kind === "reply" || kind === "mention" || kind === "quote";
      out.push({
        externalId: n.uri,
        kind,
        authorHandle: n.author.handle,
        authorId: n.author.did,
        text: replyable ? postText(n.record) : "",
        url: replyable ? bskyPostUrl(n.author.handle, n.uri) : `https://bsky.app/profile/${n.author.handle}`,
        onExternalId: n.reasonSubject ?? null,
        replyTarget: replyable ? replyTargetFor(n.uri, n.cid, n.record) : null,
        occurredAt: new Date(n.indexedAt),
      });
    }
    return out;
  },

  async discover(ctx, { keywords, limit }) {
    const agent = await agentFor(ctx);
    const out: DiscoveredPost[] = [];
    const seen = new Set<string>();
    const queries = keywords.slice(0, 4);
    const per = Math.max(5, Math.ceil(limit / Math.max(queries.length, 1)));
    for (const q of queries) {
      try {
        const { data } = await agent.app.bsky.feed.searchPosts({ q, limit: per, sort: "top" });
        for (const p of data.posts) {
          if (seen.has(p.uri) || p.author.did === ctx.account.externalId) continue;
          seen.add(p.uri);
          out.push({
            externalId: p.uri,
            url: bskyPostUrl(p.author.handle, p.uri),
            authorHandle: p.author.handle,
            authorId: p.author.did,
            text: truncate(postText(p.record), 500),
            createdAt: new Date((p.record as { createdAt?: string }).createdAt ?? p.indexedAt),
            metrics: { likes: p.likeCount ?? 0, reposts: p.repostCount ?? 0, replies: p.replyCount ?? 0 },
            replyTarget: replyTargetFor(p.uri, p.cid, p.record),
            matchedQuery: q,
          });
        }
      } catch {
        // Search is best-effort; skip failing queries.
      }
    }
    return out.slice(0, limit);
  },

  matchesUrl: (url) => /^https?:\/\/(www\.)?bsky\.app\//i.test(url),

  async resolveOwnContentUrl(ctx, url) {
    const m = url.match(/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/i);
    if (!m) return null;
    const agent = await agentFor(ctx);
    let did = m[1];
    if (!did.startsWith("did:")) {
      const r = await agent.resolveHandle({ handle: did });
      did = r.data.did;
    }
    if (did !== ctx.account.externalId) return null;
    const uri = `at://${did}/app.bsky.feed.post/${m[2]}`;
    const { data } = await agent.getPosts({ uris: [uri] });
    return data.posts[0] ? toOwn(data.posts[0]) : null;
  },

  async publish(ctx, payload: PublishPayload) {
    const agent = await agentFor(ctx);
    let text = payload.text.trim();
    if (payload.link && !text.includes(payload.link)) text = `${text}\n\n${payload.link}`.trim();
    const rt = new RichText({ text });
    await rt.detectFacets(agent);
    if (rt.graphemeLength > 300) throw new PlatformError(`Bluesky posts are limited to 300 characters (this one is ${rt.graphemeLength}).`);

    let reply: AppBskyFeedPost.Record["reply"] | undefined;
    if (payload.kind === "reply") {
      const t = payload.target?.data as { uri?: string; cid?: string; rootUri?: string; rootCid?: string } | undefined;
      if (!t?.uri || !t.cid) throw new PlatformError("Missing Bluesky reply target.");
      reply = {
        root: { uri: t.rootUri ?? t.uri, cid: t.rootCid ?? t.cid },
        parent: { uri: t.uri, cid: t.cid },
      };
    }
    const res = await agent.post({ text: rt.text, facets: rt.facets, reply, createdAt: new Date().toISOString() });
    return {
      externalId: res.uri,
      url: bskyPostUrl(ctx.account.handle, res.uri),
      kind: reply ? "reply" : "post",
    };
  },

  async like(ctx, target) {
    const t = (target.data ?? {}) as { uri?: string; cid?: string };
    if (!t.uri || !t.cid) throw new PlatformError("Missing Bluesky post to like.");
    const agent = await agentFor(ctx);
    const { data } = await agent.getPosts({ uris: [t.uri] });
    if (data.posts[0]?.viewer?.like) return { already: true };
    await agent.like(t.uri, t.cid);
    return {};
  },

  async follow(ctx, who) {
    const agent = await agentFor(ctx);
    let did = who.id?.startsWith("did:") ? who.id : null;
    if (!did && who.handle) did = (await agent.resolveHandle({ handle: who.handle.replace(/^@/, "") })).data.did;
    if (!did) throw new PlatformError("Don't know which Bluesky account to follow.");
    const { data } = await agent.getProfile({ actor: did });
    const url = `https://bsky.app/profile/${data.handle}`;
    if (data.viewer?.following) return { already: true, url };
    await agent.follow(did);
    return { url };
  },
};
