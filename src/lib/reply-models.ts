/** Models the user can pick when drafting an inbox reply. Plain data so client components can import it. */
export const REPLY_MODELS = [
  { key: "haiku", id: "claude-haiku-4-5", label: "Haiku 4.5", hint: "fastest, well under 1¢ per reply" },
  { key: "sonnet", id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "about 1¢ per reply" },
  { key: "opus", id: "claude-opus-5-5", label: "Opus 5.5", hint: "best writing, about 4¢ per reply" },
] as const;

export type ReplyModelKey = (typeof REPLY_MODELS)[number]["key"];

export const DEFAULT_REPLY_MODEL: ReplyModelKey = "haiku";

export function replyModel(key: string | null | undefined) {
  return REPLY_MODELS.find((m) => m.key === key) ?? REPLY_MODELS.find((m) => m.key === DEFAULT_REPLY_MODEL)!;
}

export function replyModelLabel(idOrKey: string | null | undefined) {
  return REPLY_MODELS.find((m) => m.id === idOrKey || m.key === idOrKey)?.label ?? idOrKey ?? "";
}
