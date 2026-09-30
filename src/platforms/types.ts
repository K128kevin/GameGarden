import type { PublishPayload } from "@/db/schema";

/**
 * Everything GameGarden knows about a social platform lives behind this
 * interface. To add a platform: implement PlatformConnector in a new file and
 * register it in ./registry.ts. Nothing else in the app is platform-specific.
 */

export type Credentials = Record<string, unknown>;

export interface ConnectedAccountInfo {
  externalId: string;
  handle: string;
  displayName?: string | null;
  profileUrl?: string | null;
  avatarUrl?: string | null;
  credentials: Credentials;
}

export interface AccountContext {
  account: { id: string; externalId: string; handle: string };
  credentials: Credentials;
  /** Persist refreshed tokens. */
  saveCredentials(next: Credentials): Promise<void>;
}

export interface ProfileStats {
  followers?: number | null;
  following?: number | null;
  postsCount?: number | null;
  extra?: Record<string, unknown>;
}

/** Content authored by the connected account. */
export interface OwnContent {
  externalId: string;
  kind: "post" | "reply" | "comment" | "video";
  url?: string | null;
  title?: string | null;
  text: string;
  community?: string | null;
  parentExternalId?: string | null;
  publishedAt: Date;
  metrics: Record<string, number>;
}

/** Something another user did that involves the connected account. */
export interface InboundInteraction {
  externalId: string;
  kind: "reply" | "mention" | "comment" | "quote" | "follow" | "like";
  authorHandle?: string | null;
  text: string;
  url?: string | null;
  onExternalId?: string | null;
  /** Connector data needed to reply to this interaction (null if not replyable). */
  replyTarget?: Record<string, unknown> | null;
  occurredAt: Date;
  /** Set when the platform shows the account owner already replied (e.g. YouTube thread replies). */
  alreadyReplied?: boolean;
}

/** A post on the platform (by someone else) worth engaging with. */
export interface DiscoveredPost {
  externalId: string;
  url?: string | null;
  authorHandle?: string | null;
  authorFollowers?: number | null;
  title?: string | null;
  text: string;
  community?: string | null;
  createdAt: Date;
  metrics: Record<string, number>;
  replyTarget?: Record<string, unknown> | null;
  matchedQuery?: string;
}

export interface PublishResult {
  externalId: string;
  url?: string | null;
  kind: OwnContent["kind"];
}

export type CredentialField = {
  name: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  help?: string;
  required?: boolean;
};

export interface PlatformCapabilities {
  /** Can publish a new top-level post. */
  post: boolean;
  /** Can reply/comment on existing content. */
  reply: boolean;
  /** Top-level posts need a title (e.g. Reddit). */
  requiresTitle?: boolean;
  /** Top-level posts need a community (e.g. a subreddit). */
  requiresCommunity?: boolean;
  communityLabel?: string;
  maxLength?: number;
  /** Human notes shown to the user and the planner. */
  notes?: string;
}

export interface PlatformConnector {
  id: string;
  name: string;
  /** Tailwind color classes for badges. */
  badgeClass: string;
  description: string;
  capabilities: PlatformCapabilities;

  /** Is the server configured (env vars present) to use this connector? */
  isConfigured(): boolean;
  configHelp: string;

  connect:
    | {
        type: "oauth";
        getAuthorizationUrl(p: { state: string; redirectUri: string }): string;
        exchangeCode(p: { code: string; redirectUri: string }): Promise<ConnectedAccountInfo>;
      }
    | {
        type: "credentials";
        fields: CredentialField[];
        connectWithCredentials(values: Record<string, string>): Promise<ConnectedAccountInfo>;
      };

  fetchProfile(ctx: AccountContext): Promise<ProfileStats>;
  fetchOwnContent(ctx: AccountContext, opts: { limit: number }): Promise<OwnContent[]>;
  fetchInteractions(ctx: AccountContext, opts: { limit: number }): Promise<InboundInteraction[]>;
  /** Search the platform for recent posts matching keywords/communities. */
  discover(
    ctx: AccountContext,
    opts: { keywords: string[]; communities: string[]; limit: number },
  ): Promise<DiscoveredPost[]>;
  /** Look up one of the account's own posts by URL (for linking to games). */
  resolveOwnContentUrl(ctx: AccountContext, url: string): Promise<OwnContent | null>;
  /** Does this URL belong to this platform? */
  matchesUrl(url: string): boolean;
  publish(ctx: AccountContext, payload: PublishPayload): Promise<PublishResult>;
}

export class PlatformError extends Error {
  constructor(
    message: string,
    public readonly reauth = false,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export async function fetchJson<T>(url: string, init: RequestInit & { errorPrefix?: string } = {}): Promise<T> {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const body = await res.text();
  if (!res.ok) {
    const reauth = res.status === 401 || res.status === 403;
    throw new PlatformError(`${init.errorPrefix ?? "Request failed"} (${res.status}): ${body.slice(0, 300)}`, reauth);
  }
  return (body ? JSON.parse(body) : {}) as T;
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
