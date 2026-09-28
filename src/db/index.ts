import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
  var __gg_sql: ReturnType<typeof postgres> | undefined;
}

function makeClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // prepare:false keeps us compatible with transaction-mode poolers (Neon, Supabase).
  return postgres(url, { prepare: false, max: process.env.NODE_ENV === "production" ? 5 : 10 });
}

const client = globalThis.__gg_sql ?? makeClient();
if (process.env.NODE_ENV !== "production") globalThis.__gg_sql = client;

export const db = drizzle(client, { schema });
export { schema };
