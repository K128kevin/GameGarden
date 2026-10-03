import type { RecommendationTarget, SocialAccount } from "@/db/schema";
import { getConnector } from "@/platforms/registry";
import { accountContext } from "./accounts";

/**
 * Like and follow, run only on explicit user action (a Follow button click, or
 * "also like / follow" ticked when approving a reply).
 */

export function canLike(platform: string, target: RecommendationTarget | null | undefined): boolean {
  const c = getConnector(platform);
  return Boolean(c.capabilities.like && c.like && target?.data);
}

export function canFollow(platform: string, target: RecommendationTarget | null | undefined): boolean {
  const c = getConnector(platform);
  if (!c.capabilities.follow || !c.follow || !target) return false;
  return Boolean(target.authorId || (c.capabilities.followByHandle && target.author));
}

export function followLabel(platform: string): string {
  return getConnector(platform).capabilities.followLabel ?? "Follow";
}

export async function likeTarget(acct: SocialAccount, target: RecommendationTarget) {
  const c = getConnector(acct.platform);
  if (!canLike(acct.platform, target)) throw new Error(`${c.name} doesn't support liking this from GameGarden.`);
  return c.like!(accountContext(acct), target);
}

export async function followAuthor(acct: SocialAccount, target: RecommendationTarget) {
  const c = getConnector(acct.platform);
  if (!canFollow(acct.platform, target)) throw new Error(`Can't ${followLabel(acct.platform).toLowerCase()} this account from GameGarden.`);
  return c.follow!(accountContext(acct), { id: target.authorId ?? null, handle: target.author ?? null });
}
