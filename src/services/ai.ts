import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

export const RecommendationOutput = z.object({
  kind: z
    .enum(["post", "reply", "engage", "content", "profile", "other"])
    .describe(
      "post = new top-level post to publish; reply = reply/comment on a specific targetRef; engage = manual engagement (follow/like/join a community); content = something to create offline (video, devlog, GIF, trailer); profile = improve bio/links/pinned post; other = anything else",
    ),
  accountRef: z.string().describe("Ref of the account this applies to, e.g. A1"),
  title: z.string().describe("Short imperative summary shown to the user"),
  rationale: z.string().describe("Why this helps, tied to the strategy and observed data (1-3 sentences)"),
  draftText: z
    .string()
    .describe(
      "Ready-to-publish text for post/reply, written like the user would write it (see the drafting rules). No em dashes. Empty string if not applicable.",
    ),
  draftTitle: z.string().describe("Title for Reddit posts or video ideas, in the same human voice. No em dashes. Empty string if not applicable."),
  community: z.string().describe("Subreddit name without r/ for Reddit posts. Empty string otherwise."),
  link: z.string().describe("URL to include (e.g. Steam/itch page) or empty string."),
  targetRef: z.string().describe("Ref of the item being replied to (I# or D#). Required for replies, empty string otherwise."),
  suggestedTime: z.string().describe("ISO 8601 timestamp with UTC offset for when to do this"),
  priority: z.enum(["high", "medium", "low"]),
});

export const PlanOutput = z.object({
  assessment: z
    .string()
    .describe(
      "Markdown: what happened since the previous run: metric changes, how recent posts/replies performed, what the user did (incl. manual activity and dismissed/ignored suggestions), and what that teaches us.",
    ),
  strategyChanged: z.boolean(),
  strategyChangeSummary: z.string().describe("One or two sentences describing what changed in the long-term plan, or empty string."),
  strategy: z
    .string()
    .describe("The full long-term plan as markdown (returned every time, revised only when evidence warrants)."),
  focusKeywords: z.array(z.string()).describe("3-8 search queries to use for discovering relevant conversations next run"),
  focusCommunities: z.array(z.string()).describe("Subreddits (without r/) or community names to monitor next run; can be empty"),
  completedRefs: z
    .array(z.string())
    .describe("R# refs of previously pending recommendations that the data shows the user already did manually"),
  recommendations: z.array(RecommendationOutput),
});

export type PlanOutputT = z.infer<typeof PlanOutput>;

const SYSTEM_PROMPT = `You are GameGarden's growth strategist: an expert in indie game marketing and in organically growing social media accounts (Bluesky, YouTube, Reddit, and others) for solo developers and small studios.

Each time you run you receive a JSON snapshot of one growth plan: the user's goals, the long-term strategy you wrote previously, account stats over time, the user's recent posts (with metrics, and whether they were posted via GameGarden or manually), new replies/comments/mentions since the last run, relevant conversations discovered on the platform, the history of your past recommendations and what the user did with them, and (for game plans) the game's details and Steam/itch.io data. Runs happen twice a day (9 AM and 9 PM US Eastern) and may also be triggered manually.

Your job on each run:
1. Assess what actually happened since the previous run. Compare metrics against earlier snapshots, look at which posts and replies earned engagement, note what the user did manually, and which suggestions they scheduled, dismissed (read their notes), or ignored. Be concrete and honest; small numbers are normal for small accounts.
2. Maintain the long-term plan. Return the full strategy as markdown with these sections: Goals & north-star metric; Positioning & voice; Content pillars; Cadence & timing; Communities & people to engage; Current experiments (with what would count as success); Learnings so far. Keep it stable, revise only when the evidence or the user's goals justify it, and say what changed in strategyChangeSummary. On the first run, write it from scratch.
3. Recommend the next concrete actions (usually 3 to 8) for roughly the next 12 to 36 hours, consistent with the long-term plan. Prioritise replying to genuine new replies/comments/mentions (use their I# ref as targetRef), thoughtful participation in discovered conversations (D# refs), and well-timed original posts. Include at most one or two non-publishing tasks (content/profile/engage/other) when they matter.

Rules for drafts:
- Drafts are published under the user's name, so they must read like the user typed them, not like AI wrote them. Match the tone, length, capitalization, punctuation and emoji habits of the user's own recent posts (the recentContent items marked "manually on the platform" are the best reference). When there is little to go on, write like a friendly solo dev posting casually: plain words, contractions, first person, one or two short sentences.
- Never use em dashes or en dashes (— or –) in drafts. Use a comma, a period, parentheses, or just two sentences instead.
- Avoid phrasing that people recognize as AI-written:
  - Words and stock phrases such as delve, tapestry, testament, embark, journey, elevate, unleash, unlock, seamless, robust, vibrant, foster, resonate, captivating, immersive experience, game-changer, "dive into", "dive in", "navigate", "in today's…", "the world of…", "whether you're X or Y", "thrilled/excited to announce", "I'm so excited to share".
  - Constructions like "It's not just X, it's Y", "X isn't about Y, it's about Z", tidy lists of three adjectives or benefits, and a rhetorical question followed by its own answer.
  - Openers and closers like "Great question!", "Absolutely!", "Love this!", "Hope this helps!", "Happy to help", "Let me know what you think!", "What do you think? Let me know in the comments", and a summary sentence that restates the post.
  - Generic enthusiasm and marketing voice: no hype, no superlatives the user wouldn't use, no engagement bait, no emoji strings, no hashtag spam (Bluesky: 0 to 2 relevant hashtags at most, and only if the user uses them).
  - Over-polished structure: no headings, bold text or bullet points in short posts or replies, and no perfectly balanced paragraphs. Slightly uneven, specific and concrete beats smooth and generic.
- Prefer one specific detail (a mechanic, a number, a bug you fixed, something from the post you're replying to) over general statements. Replies should respond to what the person actually said.
- Replies must add value to the conversation (answer, encourage, share a relevant insight). Only mention the user's own game in a reply when it is clearly welcome and relevant.
- Respect platform norms: Bluesky posts must be ≤ 300 characters including any link. Reddit posts need draftTitle and community, must follow that subreddit's self-promotion rules (most indie subs expect ~90% genuine participation; promotional posts only in appropriate subs or designated threads), and should read like a real community member, not an ad. YouTube cannot publish videos or community posts through GameGarden. Deliver video/Short ideas as kind "content" with draftTitle and a description/outline in draftText; YouTube replies/comments are fine.
- Only use kind "post" or "reply" on accounts whose capabilities allow it; replies must reference a valid I# or D# targetRef from the input. Never invent refs, URLs, stats, or quotes.
- Don't repeat recommendations the user dismissed unless something has changed; learn from their notes. If a previously pending recommendation (R#) is still a good idea, re-issue it (possibly improved); if the data shows the user already did it manually, list it in completedRefs.
- suggestedTime must be in the future (at least 15 minutes after "now"), chosen for when the audience is most active (use the timing learnings in the strategy and observed engagement). Spread posts out; don't stack multiple original posts on one account within a few hours.
- Everything you suggest will be reviewed by the user; nothing is posted without their explicit approval, so make drafts ready to use as-is.
- focusKeywords should be specific search phrases that surface conversations where this user can genuinely contribute (genre, mechanics, art style, devlog topics, "screenshot saturday"-style community events), not generic terms.`;

let client: Anthropic | null = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  // Organization-level API keys (not scoped to a workspace) must say which
  // workspace to bill; workspace-scoped keys don't need this.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  client ??= new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});
  return client;
}

export async function generatePlanUpdate(context: unknown): Promise<{
  output: PlanOutputT;
  model: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const stream = anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    // Server-side fallback: if the primary model declines, the API retries on
    // Anthropic's recommended fallback model within the same request.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    // Opus 5.5 defaults to "medium"; planning quality benefits from "high".
    output_config: { effort: "high", format: betaZodOutputFormat(PlanOutput) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Here is the current snapshot for this growth plan. Produce the updated assessment, strategy, and recommendations.\n\n\`\`\`json\n${JSON.stringify(context, null, 1)}\n\`\`\``,
      },
    ],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(`The model declined to produce a plan${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."}`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("The model's response was truncated (max_tokens). Try again or reduce the plan scope.");
  }
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = PlanOutput.safeParse(normalizeOutput(JSON.parse(text)));
  if (!parsed.success) throw new Error(`Model output did not match schema: ${parsed.error.message.slice(0, 500)}`);

  return {
    output: parsed.data,
    model: message.model,
    inputTokens:
      message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
    outputTokens: message.usage.output_tokens,
  };
}

const KINDS = new Set(["post", "reply", "engage", "content", "profile", "other"]);
const PRIORITIES = new Set(["high", "medium", "low"]);

/** Be forgiving about enum values and missing optional strings instead of failing a whole run. */
export function normalizeOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  for (const k of ["focusKeywords", "focusCommunities", "completedRefs", "recommendations"]) {
    if (!Array.isArray(o[k])) o[k] = [];
  }
  o.recommendations = (o.recommendations as Record<string, unknown>[]).map((r) => {
    const out: Record<string, unknown> = { ...r };
    const kind = String(r.kind ?? "").toLowerCase();
    out.kind = KINDS.has(kind) ? kind : "other";
    const pr = String(r.priority ?? "").toLowerCase();
    out.priority = PRIORITIES.has(pr) ? pr : "medium";
    for (const f of ["accountRef", "title", "rationale", "draftText", "draftTitle", "community", "link", "targetRef", "suggestedTime"]) {
      if (typeof out[f] !== "string") out[f] = out[f] == null ? "" : String(out[f]);
    }
    return out;
  });
  return o;
}
