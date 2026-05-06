import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.POSTGRES_URL!;

// Use `prepare: false` for Supabase connection pooler (PgBouncer in transaction mode)
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
