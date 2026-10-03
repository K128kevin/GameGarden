import type { Recommendation, SocialAccount } from "@/db/schema";
import { findConnector } from "@/platforms/registry";
import type { RecView } from "@/components/recommendation-card";
import { canFollow, canLike, followLabel } from "@/services/social-actions";
import { formatDateTime, toLocalInput } from "./time";

export function toRecView(
  r: Recommendation,
  accounts: Map<string, SocialAccount>,
  tz: string,
  gameNames?: Map<string, string>,
): RecView {
  const acct = r.accountId ? accounts.get(r.accountId) : undefined;
  const c = acct ? findConnector(acct.platform) : undefined;
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    rationale: r.rationale,
    draftText: r.draftText,
    draftTitle: r.draftTitle,
    community: r.community,
    link: r.link,
    priority: r.priority,
    status: r.status,
    userNote: r.userNote,
    suggestedLabel: r.suggestedFor ? formatDateTime(r.suggestedFor, tz) : null,
    suggestedLocal: r.suggestedFor ? toLocalInput(r.suggestedFor, tz) : null,
    suggestedInPast: r.suggestedFor ? r.suggestedFor.getTime() < Date.now() : false,
    target: r.target
      ? { url: r.target.url, author: r.target.author, excerpt: r.target.excerpt, community: r.target.community }
      : null,
    account:
      acct && c
        ? { platform: c.id, platformName: c.name, badgeClass: c.badgeClass, handle: acct.handle, capabilities: c.capabilities }
        : null,
    gameName: r.gameId ? (gameNames?.get(r.gameId) ?? null) : null,
    likeable: Boolean(acct && r.kind === "reply" && canLike(acct.platform, r.target)),
    followable: Boolean(acct && (r.kind === "reply" || r.kind === "follow") && canFollow(acct.platform, r.target)),
    followLabel: acct ? followLabel(acct.platform) : "Follow",
  };
}
