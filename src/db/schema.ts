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
    // Password hashes live on `accounts` (provider "credential"), not here —
    // better-auth's real credential-auth codepath reads/writes
    // accounts.password, never a column on the user row (verified via
    // `better-auth generate` against this exact auth.ts config).
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    image: text("image"),
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
    token: text("token").notNull(), // Cookie value; the actual per-request session lookup key.
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
    tokenIdx: uniqueIndex("sessions_token_idx").on(t.token),
  }),
);

// One row per authentication method linked to a user — better-auth's
// "account" table (TRD-style pluralized name, mapped in auth.ts). Credential
// (email+password) rows use provider_id="credential" and store the PBKDF2
// hash in `password`; OAuth rows (google/github) store provider tokens.
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"), // PBKDF2-SHA256 via crypto.subtle only; never bcrypt/argon2 (TRD §3.1.2)
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    userIdx: index("accounts_user_idx").on(t.userId),
  }),
);

// Short-lived tokens for email verification / password reset flows.
export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    identifierIdx: index("verifications_identifier_idx").on(t.identifier),
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
