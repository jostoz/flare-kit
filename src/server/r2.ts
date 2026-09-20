import { Hono } from "hono";
import { AwsClient } from "aws4fetch";

export interface R2Env {
  ASSETS_BUCKET: R2Bucket;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
  "application/pdf": true,
};

/**
 * Direct-to-R2 presigned uploads (TRD §3.6): the file bytes never transit
 * the Worker, so uploads consume zero CPU and zero memory against the
 * 10ms/128MB budget.
 */
export function createR2Router() {
  const router = new Hono<{ Bindings: R2Env; Variables: { userId: string } }>();

  router.post("/sign", async (c) => {
    const { filename, contentType, size } = await c.req.json<{ filename: string; contentType: string; size: number }>();

    if (!ALLOWED_CONTENT_TYPES[contentType]) return c.json({ error: "unsupported_content_type" }, 400);
    if (size > MAX_UPLOAD_BYTES) return c.json({ error: "file_too_large", maxBytes: MAX_UPLOAD_BYTES }, 400);

    const userId = c.get("userId");
    const key = `${userId}/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    // R2 presigned URLs are generated through the S3-compatible API using the
    // account's R2 access keys (set as secrets), not through the binding.
    const endpoint = `https://${c.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const client = new AwsClient({
      accessKeyId: c.env.R2_ACCESS_KEY_ID,
      secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    });
    const signed = await client.sign(
      new Request(`${endpoint}/${c.env.R2_BUCKET_NAME}/${key}`, { method: "PUT", headers: { "content-type": contentType } }),
      { aws: { signQuery: true } },
    );

    return c.json({ key, uploadUrl: signed.url, expiresIn: 900 });
  });

  return router;
}
