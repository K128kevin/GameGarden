import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: [".env.local", ".env"], quiet: true });

// Migrations prefer a direct (non-pooled) connection when the provider offers one:
// Neon → DATABASE_URL_UNPOOLED, Supabase/Vercel Postgres → POSTGRES_URL_NON_POOLING.
const url = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: url! },
});
