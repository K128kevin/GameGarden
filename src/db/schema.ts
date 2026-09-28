import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/* -------------------------------------------------------------------------- */
/* Auth (Better Auth core schema)                                             */
/* -------------------------------------------------------------------------- */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  timezone: text("timezone").notNull().default("America/New_York"),
  /** Encrypted itch.io API key (optional) used to pull view/download stats. */
  itchApiKey: text("itch_api_key"),
  updatedAt: updatedAt(),
});

/**
 * A connected social media account. `platform` is a free-form string that
 * matches a connector id in src/platforms/registry.ts, so adding a platform
 * never requires a migration.
 */
export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    externalId: text("external_id").notNull(),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    profileUrl: text("profile_url"),
    avatarUrl: text("avatar_url"),
    /** AES-GCM encrypted JSON blob of connector-specific credentials. */
    credentials: text("credentials").notNull(),
    status: text("status").notNull().default("active"), // active | error
    statusMessage: text("status_message"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("social_accounts_user_platform_ext").on(t.userId, t.platform, t.externalId)],
);

export const accountSnapshots = pgTable(
  "account_snapshots",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    followers: integer("followers"),
    following: integer("following"),
    postsCount: integer("posts_count"),
    extra: jsonb("extra").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("account_snapshots_account_idx").on(t.accountId, t.capturedAt)],
);

/** Content the user authored on a platform (synced or published via the app). */
export const contentItems = pgTable(
  "content_items",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(), // post | reply | comment | video
    url: text("url"),
    title: text("title"),
    text: text("text").notNull().default(""),
    community: text("community"),
    parentExternalId: text("parent_external_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    metrics: jsonb("metrics").$type<Record<string, number>>().notNull().default({}),
    /** "synced" = found on the platform (possibly posted manually), "app" = published by GameGarden. */
    source: text("source").notNull().default("synced"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("content_items_account_ext").on(t.accountId, t.externalId),
    index("content_items_published_idx").on(t.accountId, t.publishedAt),
  ],
);

/** Replies, mentions, comments and follows from other people. */
export const interactions = pgTable(
  "interactions",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(), // reply | mention | comment | quote | follow | like
    authorHandle: text("author_handle"),
    text: text("text").notNull().default(""),
    url: text("url"),
    onExternalId: text("on_external_id"),
    replyTarget: jsonb("reply_target").$type<Record<string, unknown> | null>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("interactions_account_ext").on(t.accountId, t.externalId),
    index("interactions_occurred_idx").on(t.accountId, t.occurredAt),
  ],
);

export const games = pgTable("games", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  pitch: text("pitch").notNull().default(""),
  description: text("description").notNull().default(""),
  genres: text("genres").notNull().default(""),
  releaseStatus: text("release_status").notNull().default("in_development"),
  releaseDate: text("release_date"),
  itchUrl: text("itch_url"),
  steamUrl: text("steam_url"),
  steamAppId: text("steam_app_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const gameAccounts = pgTable(
  "game_accounts",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.accountId] })],
);

export const gameContent = pgTable(
  "game_content",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    contentItemId: text("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.contentItemId] })],
);

export const storeSnapshots = pgTable(
  "store_snapshots",
  {
    id: id(),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    store: text("store").notNull(), // steam | itch
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("store_snapshots_game_idx").on(t.gameId, t.store, t.capturedAt)],
);

/**
 * A growth plan: one per opted-in account (kind=account_growth) or game
 * (kind=game_marketing). Holds the long-term strategy that each run revises.
 */
export const plans = pgTable(
  "plans",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // account_growth | game_marketing
    accountId: text("account_id").references(() => socialAccounts.id, { onDelete: "cascade" }),
    gameId: text("game_id").references(() => games.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    goals: text("goals").notNull().default(""),
    strategy: text("strategy").notNull().default(""),
    strategyUpdatedAt: timestamp("strategy_updated_at", { withTimezone: true }),
    focusKeywords: jsonb("focus_keywords").$type<string[]>().notNull().default([]),
    focusCommunities: jsonb("focus_communities").$type<string[]>().notNull().default([]),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    optedInAt: timestamp("opted_in_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("plans_account_unique")
      .on(t.accountId)
      .where(sql`${t.kind} = 'account_growth'`),
    uniqueIndex("plans_game_unique")
      .on(t.gameId)
      .where(sql`${t.kind} = 'game_marketing'`),
  ],
);

export const planRuns = pgTable(
  "plan_runs",
  {
    id: id(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    /** e.g. "2026-09-28-am" for scheduled runs, "manual-<ts>" otherwise. */
    slot: text("slot").notNull(),
    trigger: text("trigger").notNull(), // scheduled | manual
    status: text("status").notNull().default("running"), // running | succeeded | failed
    attempts: integer("attempts").notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    assessment: text("assessment"),
    strategyChanged: boolean("strategy_changed").notNull().default(false),
    strategyChangeSummary: text("strategy_change_summary"),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
  },
  (t) => [
    uniqueIndex("plan_runs_plan_slot").on(t.planId, t.slot),
    index("plan_runs_plan_started").on(t.planId, t.startedAt),
  ],
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: id(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => planRuns.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").references(() => socialAccounts.id, { onDelete: "set null" }),
    gameId: text("game_id").references(() => games.id, { onDelete: "set null" }),
    /** post | reply | engage | content | profile | other */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    rationale: text("rationale").notNull().default(""),
    draftText: text("draft_text"),
    draftTitle: text("draft_title"),
    community: text("community"),
    link: text("link"),
    target: jsonb("target").$type<RecommendationTarget | null>(),
    suggestedFor: timestamp("suggested_for", { withTimezone: true }),
    priority: text("priority").notNull().default("medium"),
    /** pending | scheduled | posted | done | dismissed | expired | failed */
    status: text("status").notNull().default("pending"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    userNote: text("user_note"),
    createdAt: createdAt(),
  },
  (t) => [index("recommendations_plan_idx").on(t.planId, t.createdAt), index("recommendations_status_idx").on(t.userId, t.status)],
);

export type RecommendationTarget = {
  externalId: string;
  url?: string | null;
  author?: string | null;
  excerpt?: string | null;
  community?: string | null;
  /** Connector-specific data needed to reply (e.g. Bluesky cid/root). */
  data?: Record<string, unknown> | null;
};

export type PublishPayload = {
  kind: "post" | "reply";
  text: string;
  title?: string | null;
  community?: string | null;
  link?: string | null;
  target?: RecommendationTarget | null;
};

/**
 * Something the user explicitly approved to be published. The publisher only
 * ever acts on rows in this table with approvedAt set.
 */
export const scheduledActions = pgTable(
  "scheduled_actions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    recommendationId: text("recommendation_id").references(() => recommendations.id, { onDelete: "set null" }),
    gameId: text("game_id").references(() => games.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<PublishPayload>().notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    /** scheduled | publishing | published | failed | canceled */
    status: text("status").notNull().default("scheduled"),
    attempts: integer("attempts").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    resultExternalId: text("result_external_id"),
    resultUrl: text("result_url"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("scheduled_actions_due_idx").on(t.status, t.scheduledFor)],
);

/** Append-only history of what happened (for the UI and for LLM context). */
export const activityLog = pgTable(
  "activity_log",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    planId: text("plan_id").references(() => plans.id, { onDelete: "cascade" }),
    accountId: text("account_id").references(() => socialAccounts.id, { onDelete: "set null" }),
    gameId: text("game_id").references(() => games.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    message: text("message").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("activity_log_user_idx").on(t.userId, t.createdAt), index("activity_log_plan_idx").on(t.planId, t.createdAt)],
);

export type SocialAccount = typeof socialAccounts.$inferSelect;
export type Game = typeof games.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type PlanRun = typeof planRuns.$inferSelect;
export type Recommendation = typeof recommendations.$inferSelect;
export type ScheduledAction = typeof scheduledActions.$inferSelect;
export type ContentItem = typeof contentItems.$inferSelect;
export type Interaction = typeof interactions.$inferSelect;

/** Small key/value store for app-wide status (e.g. last heartbeat). */
export const systemState = pgTable("system_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
