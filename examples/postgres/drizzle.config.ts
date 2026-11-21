import { defineConfig } from "drizzle-kit";

// The audit tables live in YOUR schema (src/schema.ts) next to your own, so
// drizzle-kit migrates them like any other table: `bun run db:generate` writes
// SQL migrations to ./drizzle, `bun run db:push` applies the schema directly.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://audit:audit@localhost:54329/audit",
  },
});
