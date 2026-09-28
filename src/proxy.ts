import { NextResponse, type NextRequest } from "next/server";

/**
 * Sign-in only works on the URL in BETTER_AUTH_URL (Better Auth rejects other
 * origins, and OAuth redirect URIs are registered for that URL). In production,
 * send visitors on any other *.vercel.app address for this project (deployment
 * or branch URLs) to the canonical one.
 */
export function proxy(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "production") return NextResponse.next();
  const configured = process.env.APP_URL || process.env.BETTER_AUTH_URL;
  if (!configured) return NextResponse.next();

  let canonical: URL;
  try {
    canonical = new URL(configured);
  } catch {
    return NextResponse.next();
  }
  // Never redirect production traffic to a non-public URL (e.g. a leftover localhost value).
  if (canonical.protocol !== "https:" || canonical.hostname === "localhost") return NextResponse.next();

  const host = request.headers.get("host")?.toLowerCase();
  if (!host || host === canonical.host || !host.endsWith(".vercel.app")) return NextResponse.next();

  const target = new URL(request.nextUrl.pathname + request.nextUrl.search, canonical);
  return NextResponse.redirect(target, 308);
}

export const config = {
  // Pages only: leave API routes (auth callbacks, cron pingers) and static assets alone.
  matcher: ["/((?!api/|_next/|favicon.ico).*)"],
};
