import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { getSessionUser } from "@/lib/session";
import { findConnector } from "@/platforms/registry";
import { syncAccount, upsertConnectedAccount } from "@/services/accounts";

export const maxDuration = 60;

export async function GET(req: Request, ctx: RouteContext<"/api/connect/[platform]/callback">) {
  const { platform } = await ctx.params;
  const url = new URL(req.url);
  const fail = (msg: string) => NextResponse.redirect(`${appUrl()}/accounts?error=${encodeURIComponent(msg)}`);

  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(`${appUrl()}/`);
  const connector = findConnector(platform);
  if (!connector || connector.connect.type !== "oauth") return fail("Unsupported platform");

  const jar = await cookies();
  const cookie = jar.get(`gg_oauth_${platform}`)?.value;
  jar.delete(`gg_oauth_${platform}`);
  const [state, uid] = cookie?.split(".") ?? [];
  if (!state || state !== url.searchParams.get("state") || uid !== user.id) return fail("OAuth state mismatch — please try again.");
  if (url.searchParams.get("error")) return fail(`${connector.name} authorization was denied: ${url.searchParams.get("error")}`);
  const code = url.searchParams.get("code");
  if (!code) return fail("Missing authorization code");

  try {
    const info = await connector.connect.exchangeCode({ code, redirectUri: `${appUrl()}/api/connect/${platform}/callback` });
    const acct = await upsertConnectedAccount(user.id, platform, info);
    await syncAccount(acct);
    return NextResponse.redirect(`${appUrl()}/accounts/${acct.id}?connected=1`);
  } catch (e) {
    return fail((e as Error).message);
  }
}
