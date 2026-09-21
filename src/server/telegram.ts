/**
 * Telegram channel: a webhook endpoint wired to the same chat+memory core
 * (runChatTurn, src/server/ai.ts) the authenticated HTTP JSON route uses —
 * conversation memory, quota accounting, smart routing, vision, and
 * tool-calling all behave identically regardless of which channel a
 * message arrives on.
 *
 * No better-auth session exists for a Telegram user; `userId` is a
 * synthetic `telegram:<chatId>` string instead. `messages`/`ai_usage` have
 * no foreign-key constraint on `users` (src/db/schema.ts), so this works
 * without provisioning a shadow user row per chat.
 *
 * Trust boundary: Telegram's webhook has no session cookie to check, so
 * `TELEGRAM_WEBHOOK_SECRET` (set via the `secret_token` param when
 * registering the webhook — see README "Telegram setup") is compared
 * against the `X-Telegram-Bot-Api-Secret-Token` header Telegram sends on
 * every webhook request. A request without a matching header is rejected
 * before touching the database or spending any inference budget.
 */

import { Hono } from "hono";
import type { Db } from "../db/client";
import { runChatTurn, DailyQuotaReachedError, InvalidImageError, type AiEnv } from "./ai";
import { QuotaExceededError } from "./quota";
import { VisionUnavailableError } from "./ai-providers";

export interface TelegramEnv extends AiEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

interface TelegramPhotoSize {
  file_id: string;
}

interface TelegramMessage {
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
}

interface TelegramUpdate {
  message?: TelegramMessage;
}

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

async function sendTelegramMessage(botToken: string, chatId: number, text: string, fetchImpl: typeof fetch): Promise<void> {
  await fetchImpl(`${TELEGRAM_API_BASE}${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

/** Resolves a Telegram `file_id` to a base64-encoded image the same shape runChatTurn expects. */
async function fetchTelegramImage(botToken: string, fileId: string, fetchImpl: typeof fetch): Promise<{ mimeType: string; data: string }> {
  const fileRes = await fetchImpl(`${TELEGRAM_API_BASE}${botToken}/getFile?file_id=${fileId}`);
  const fileBody = (await fileRes.json()) as { result?: { file_path?: string } };
  const filePath = fileBody.result?.file_path;
  if (!filePath) throw new Error("Telegram getFile returned no file_path");

  const downloadRes = await fetchImpl(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  const bytes = new Uint8Array(await downloadRes.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
  return { mimeType, data: btoa(binary) };
}

/**
 * `fetchImpl` defaults to the real global `fetch` — overridable in tests
 * for the same reason cron.ts's `reconcileNeuronUsage` takes one: this
 * repo's `cloudflare:test` version has no in-isolate `fetchMock`.
 */
export function createTelegramRouter(fetchImpl: typeof fetch = fetch) {
  const router = new Hono<{ Bindings: TelegramEnv; Variables: { db: Db } }>();

  router.post("/webhook", async (c) => {
    if (!c.env.TELEGRAM_BOT_TOKEN || !c.env.TELEGRAM_WEBHOOK_SECRET) {
      return c.json({ error: "telegram_not_configured" }, 503);
    }
    if (c.req.header("X-Telegram-Bot-Api-Secret-Token") !== c.env.TELEGRAM_WEBHOOK_SECRET) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const update = await c.req.json<TelegramUpdate>();
    const message = update.message;
    // Telegram sends many update types (edited_message, channel_post, ...)
    // this bot doesn't handle; 200 + no-op is the documented way to
    // acknowledge and avoid Telegram's retry-with-backoff.
    if (!message) return c.json({ ok: true });

    const chatId = message.chat.id;
    const userId = `telegram:${chatId}`;
    const prompt = message.text ?? message.caption ?? "";
    const botToken = c.env.TELEGRAM_BOT_TOKEN;

    try {
      let image: { mimeType: string; data: string } | undefined;
      if (message.photo && message.photo.length > 0) {
        // Telegram sends multiple resolutions; the last is the largest.
        const largest = message.photo[message.photo.length - 1];
        image = await fetchTelegramImage(botToken, largest.file_id, fetchImpl);
      }

      if (!prompt && !image) {
        await sendTelegramMessage(botToken, chatId, "Send text or a photo with a caption.", fetchImpl);
        return c.json({ ok: true });
      }

      const { text } = await runChatTurn(c.env, c.get("db"), userId, prompt, image);
      await sendTelegramMessage(botToken, chatId, text, fetchImpl);
    } catch (err) {
      const reply =
        err instanceof DailyQuotaReachedError
          ? err.message
          : err instanceof InvalidImageError
            ? err.message
            : err instanceof VisionUnavailableError
              ? err.message
              : err instanceof QuotaExceededError
                ? "This service is temporarily busy — please try again shortly."
                : "Something went wrong handling that message.";
      await sendTelegramMessage(botToken, chatId, reply, fetchImpl);
    }

    // Always 200: Telegram retries (with backoff, eventually giving up)
    // on any non-2xx response, which would resend the same update.
    return c.json({ ok: true });
  });

  return router;
}
