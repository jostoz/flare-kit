import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

/**
 * Every WHERE/JOIN/ORDER BY column below is indexed (TRD §3.2).
 * Every index adds +1 row-write per INSERT — keep this list minimal.
 */

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash"), // PBKDF2-SHA256 via crypto.subtle only; never bcrypt/argon2 (TRD §3.1.2)
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
    stripeCustomerIdx: uniqueIndex("users_stripe_customer_idx").on(t.stripeCustomerId),
  }),
);

// Sessions live in D1, never KV (KV free write quota is 1,000/day — TRD §0 item 1).
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
);

// Idempotency guard for Stripe webhook retries (TRD §3.4).
export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  processedAt: integer("processed_at").notNull(),
});

// Per-user daily Neuron quota (TRD §3.5) — prevents one user exhausting the
// account-wide 10,000 Neurons/day shared pool.
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    userId: text("user_id").notNull(),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    neurons: integer("neurons").notNull().default(0),
  },
  (t) => ({
    pk: uniqueIndex("ai_usage_user_day_idx").on(t.userId, t.day),
  }),
);
