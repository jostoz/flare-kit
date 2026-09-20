import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Db } from "../db/client";
import { schema } from "../db/client";

/**
 * Sessions live in D1 (TRD §3.3), never KV — KV's free write quota is
 * 1,000/day, far below what session churn needs. PBKDF2-SHA256 via
 * crypto.subtle is the only permitted password hash: bcrypt/argon2 cost
 * 50-300ms of CPU against a 10ms/request ceiling (TRD §3.1.2).
 */
export function createAuth(db: Db, env: { AUTH_SECRET: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string }) {
  return betterAuth({
    secret: env.AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema: { user: schema.users, session: schema.sessions } }),
    emailAndPassword: {
      enabled: true,
      password: {
        hash: hashPassword,
        verify: verifyPassword,
      },
    },
    socialProviders: {
      google: env.GOOGLE_CLIENT_ID
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET! }
        : undefined,
      github: env.GITHUB_CLIENT_ID
        ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET! }
        : undefined,
    },
    session: {
      // Rotate updatedAt at most once per 24h, not per-request — bounds
      // session-table writes against the D1 daily write quota (TRD §3.3).
      updateAge: 60 * 60 * 24,
      expiresIn: 60 * 60 * 24 * 30,
    },
  });
}

const PBKDF2_ITERATIONS = 210_000;

/** PBKDF2-SHA256 via WebCrypto — runs on native crypto, not counted as Worker JS CPU time. */
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePbkdf2Bits(password, salt);
  return `${bufferToHex(salt)}:${bufferToHex(derived)}`;
}

async function verifyPassword({ password, hash }: { password: string; hash: string }): Promise<boolean> {
  const [saltHex, expectedHex] = hash.split(":");
  const salt = hexToBuffer(saltHex);
  const derived = await derivePbkdf2Bits(password, salt);
  return bufferToHex(derived) === expectedHex;
}

async function derivePbkdf2Bits(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.slice().buffer, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function bufferToHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuffer(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
