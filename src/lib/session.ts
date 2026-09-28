import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { auth } from "./auth";
import { allowedEmails } from "./env";
import { db } from "@/db";
import { userSettings } from "@/db/schema";

export const getSessionUser = cache(async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const allowed = allowedEmails();
  if (allowed && !allowed.includes(session.user.email.toLowerCase())) return null;
  return session.user;
});

export async function requireUser() {
  const user = await getSessionUser();
  if (!user) redirect("/");
  return user;
}

export const getUserSettings = cache(async (userId: string) => {
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  if (row) return row;
  const [created] = await db.insert(userSettings).values({ userId }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(userSettings).where(eq(userSettings.userId, userId)))[0];
});
