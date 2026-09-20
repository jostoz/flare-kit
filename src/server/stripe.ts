import { Hono } from "hono";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { schema } from "../db/client";
import { withQuotaGuard, degradedResponse, QuotaExceededError } from "./quota";

export interface StripeEnv {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID: string;
  APP_URL: string;
}

export function createStripeRouter() {
  const router = new Hono<{ Bindings: StripeEnv; Variables: { userId: string; db: Db } }>();

  router.post("/checkout", async (c) => {
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: "2025-08-27.basil" });
    const db = c.get("db");
    const userId = c.get("userId");
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: user.stripeCustomerId ?? undefined,
      customer_email: user.stripeCustomerId ? undefined : user.email,
      line_items: [{ price: c.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${c.env.APP_URL}/billing/success`,
      cancel_url: `${c.env.APP_URL}/billing/cancelled`,
      client_reference_id: userId,
    });

    return c.json({ url: session.url });
  });

  router.post("/webhook", async (c) => {
    const db = c.get("db");
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: "2025-08-27.basil" });
    const signature = c.req.header("stripe-signature");
    if (!signature) return c.json({ error: "missing_signature" }, 400);

    const body = await c.req.text();
    let event: Stripe.Event;
    try {
      // constructEventAsync is REQUIRED on Workers: the sync variant relies
      // on Node's crypto module, which is unavailable (TRD §3.4).
      event = await stripe.webhooks.constructEventAsync(body, signature, c.env.STRIPE_WEBHOOK_SECRET);
    } catch {
      return c.json({ error: "invalid_signature" }, 400);
    }

    try {
      const alreadyProcessed = await withQuotaGuard(() =>
        db.select({ id: schema.stripeEvents.id }).from(schema.stripeEvents).where(eq(schema.stripeEvents.id, event.id)).limit(1),
      );
      if (alreadyProcessed.length > 0) return c.json({ received: true, deduped: true });

      await withQuotaGuard(
        () => db.insert(schema.stripeEvents).values({ id: event.id, processedAt: Date.now() }).onConflictDoNothing(),
        "d1_write",
      );
    } catch (err) {
      if (err instanceof QuotaExceededError) return degradedResponse(err);
      throw err;
    }

    // Respond fast; defer non-critical follow-up work.
    c.executionCtx.waitUntil(applySubscriptionEvent(db, event));
    return c.json({ received: true });
  });

  return router;
}

async function applySubscriptionEvent(db: Db, event: Stripe.Event) {
  if (event.type !== "checkout.session.completed") return;
  const session = event.data.object as Stripe.Checkout.Session;
  if (!session.client_reference_id || !session.customer) return;
  await db
    .update(schema.users)
    .set({ stripeCustomerId: String(session.customer) })
    .where(eq(schema.users.id, session.client_reference_id));
}
