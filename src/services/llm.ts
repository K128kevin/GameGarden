import Anthropic from "@anthropic-ai/sdk";
import { replyModel, type ReplyModelKey } from "@/lib/reply-models";

let client: Anthropic | null = null;

/** Shared Claude client. */
export function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  // Organization-level API keys (not scoped to a workspace) must say which
  // workspace to bill; workspace-scoped keys don't need this.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  client ??= new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});
  return client;
}

export type TextResult = { text: string; model: string; inputTokens: number; outputTokens: number };

/**
 * Short plain-text generation for drafts (inbox replies, regenerated suggestions). Request shape differs by model:
 * Haiku 4.5 takes no effort/adaptive-thinking settings; Sonnet 5.5 and Opus 5.5 use
 * adaptive thinking with an explicit effort.
 */
export async function generateDraftText(opts: { model: ReplyModelKey; system: string; prompt: string }): Promise<TextResult> {
  const m = replyModel(opts.model);
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: m.id,
    max_tokens: m.key === "haiku" ? 1024 : 16000,
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
    ...(m.key === "haiku"
      ? {}
      : { thinking: { type: "adaptive" as const }, output_config: { effort: m.key === "opus" ? ("high" as const) : ("medium" as const) } }),
  };

  let message: Anthropic.Message;
  try {
    message = await anthropic().messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.NotFoundError) throw new Error(`${m.label} isn't available on your Anthropic account. Pick another model.`);
    if (e instanceof Anthropic.RateLimitError) throw new Error("Anthropic rate limit hit. Try again in a minute.");
    if (e instanceof Anthropic.AuthenticationError) throw new Error("Anthropic rejected the API key. Check ANTHROPIC_API_KEY in Vercel.");
    if (e instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${e.status}: ${e.message}`);
    throw e;
  }
  if (message.stop_reason === "refusal") throw new Error(`${m.label} declined to draft this reply. Try another model or write it yourself.`);
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error(`${m.label} returned an empty draft. Try again.`);
  return { text, model: message.model, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
}
