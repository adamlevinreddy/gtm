import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Neon's Vercel integration sets the POSTGRES_URL* compatibility vars; fall
// back to DATABASE_URL so any provider's default naming works unchanged.
const connectionString = (process.env.POSTGRES_URL ?? process.env.DATABASE_URL)!;

// `prepare: false` for transaction-mode poolers (Supabase PgBouncer, Neon pooler)
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
