import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { APIError } from "better-auth/api";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { allowedEmails, appUrl } from "./env";

export const auth = betterAuth({
  baseURL: appUrl(),
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      prompt: "select_account",
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  databaseHooks: {
    user: {
      create: {
        // While the app is personal, restrict sign-ups to ALLOWED_EMAILS.
        // Leave ALLOWED_EMAILS unset to open sign-ups to anyone with a Google account.
        before: async (u) => {
          const allowed = allowedEmails();
          if (allowed && !allowed.includes(u.email.toLowerCase())) {
            throw new APIError("FORBIDDEN", { message: "This GameGarden instance is invite-only." });
          }
        },
      },
    },
  },
  plugins: [nextCookies()],
});
