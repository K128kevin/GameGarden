import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { getSessionUser } from "@/lib/session";
import { findConnector } from "@/platforms/registry";

export async function GET(_req: Request, ctx: RouteContext<"/api/connect/[platform]/start">) {
  const { platform } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(`${appUrl()}/`);
  const connector = findConnector(platform);
  if (!connector || connector.connect.type !== "oauth") {
    return NextResponse.redirect(`${appUrl()}/accounts?error=${encodeURIComponent("Unsupported platform")}`);
  }
  if (!connector.isConfigured()) {
    return NextResponse.redirect(`${appUrl()}/accounts?error=${encodeURIComponent(`${connector.name} isn't configured: ${connector.configHelp}`)}`);
  }
  const state = randomBytes(24).toString("base64url");
  (await cookies()).set(`gg_oauth_${platform}`, `${state}.${user.id}`, {
    httpOnly: true,
    secure: appUrl().startsWith("https"),
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  const redirectUri = `${appUrl()}/api/connect/${platform}/callback`;
  return NextResponse.redirect(connector.connect.getAuthorizationUrl({ state, redirectUri }));
}
