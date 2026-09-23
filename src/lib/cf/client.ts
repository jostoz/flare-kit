const API_BASE = "https://api.cloudflare.com/client/v4";

export interface CfResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

export class CloudflareApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly errors: Array<{ code: number; message: string }>,
  ) {
    super(`Cloudflare API error on ${path}: ${errors.map((e) => `[${e.code}] ${e.message}`).join(", ")}`);
  }
}

/** Thin typed wrapper over the REST endpoints listed in TRD §5.2. Never logs the token. */
export class CloudflareClient {
  constructor(private readonly apiToken: string) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const isFormData = init.body instanceof FormData;
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
    const body = (await res.json()) as CfResponse<T>;
    if (!body.success) throw new CloudflareApiError(path, body.errors);
    return body.result;
  }

  async verifyToken(): Promise<{ id: string; status: string }> {
    return this.request("/user/tokens/verify");
  }

  async getAccountId(): Promise<string> {
    const accounts = await this.request<Array<{ id: string; name: string }>>("/accounts");
    if (accounts.length === 0) throw new Error("Token has no account access.");
    return accounts[0].id;
  }

  async findOrCreateD1(accountId: string, name: string): Promise<{ uuid: string }> {
    const existing = await this.request<Array<{ uuid: string; name: string }>>(`/accounts/${accountId}/d1/database`);
    const found = existing.find((db) => db.name === name);
    if (found) return found;
    return this.request(`/accounts/${accountId}/d1/database`, { method: "POST", body: JSON.stringify({ name }) });
  }

  async findOrCreateKv(accountId: string, title: string): Promise<{ id: string }> {
    const existing = await this.request<Array<{ id: string; title: string }>>(`/accounts/${accountId}/storage/kv/namespaces`);
    const found = existing.find((ns) => ns.title === title);
    if (found) return found;
    return this.request(`/accounts/${accountId}/storage/kv/namespaces`, { method: "POST", body: JSON.stringify({ title }) });
  }

  async findOrCreateR2(accountId: string, name: string): Promise<{ name: string }> {
    const existing = await this.request<{ buckets: Array<{ name: string }> }>(`/accounts/${accountId}/r2/buckets`);
    const found = existing.buckets.find((b) => b.name === name);
    if (found) return found;
    return this.request(`/accounts/${accountId}/r2/buckets`, { method: "POST", body: JSON.stringify({ name }) });
  }

  async runD1Query(accountId: string, databaseId: string, sql: string): Promise<unknown> {
    return this.request(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql }),
    });
  }

  async deployWorker(accountId: string, name: string, formData: FormData): Promise<unknown> {
    return this.request(`/accounts/${accountId}/workers/scripts/${name}`, { method: "PUT", body: formData });
  }

  /**
   * Workers Static Assets direct-upload flow (this raw multipart deploy
   * path doesn't read wrangler.jsonc's `assets` block at all — see
   * scripts/bootstrap.ts). Registers a manifest of files-to-serve; the
   * response's `buckets` lists which file hashes still need uploading
   * (already-uploaded-by-hash files are omitted, so a rerun with
   * unchanged files skips real upload work).
   */
  async createAssetsUploadSession(
    accountId: string,
    workerName: string,
    manifest: Record<string, { hash: string; size: number }>,
  ): Promise<{ jwt: string; buckets: string[][] }> {
    return this.request(`/accounts/${accountId}/workers/scripts/${workerName}/assets-upload-session`, {
      method: "POST",
      body: JSON.stringify({ manifest }),
    });
  }

  /**
   * Uploads one bucket (batch of file hashes) from `createAssetsUploadSession`.
   * Authenticated with the short-lived upload JWT from that call, NOT this
   * client's own account-scoped API token — `request()`'s default
   * `Authorization` header is overridden via `init.headers` (spread last).
   * Each part's `Content-Type` is what Cloudflare serves the file with
   * later — `application/null` (skip the header) would break CSS/JS
   * serving, so callers must supply the real MIME type per file. The
   * final bucket's response carries the completion JWT needed by the
   * script deploy's `metadata.assets.jwt`.
   */
  async uploadAssetBucket(accountId: string, uploadJwt: string, files: Array<{ hash: string; contentType: string; base64: string }>): Promise<{ jwt?: string }> {
    const form = new FormData();
    for (const { hash, contentType, base64 } of files) {
      form.append(hash, new Blob([base64], { type: contentType }), hash);
    }
    return this.request(`/accounts/${accountId}/workers/assets/upload?base64=true`, {
      method: "POST",
      body: form,
      headers: { Authorization: `Bearer ${uploadJwt}` },
    });
  }


  async enableSubdomain(accountId: string, name: string): Promise<{ subdomain: string }> {
    return this.request(`/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
  }

  async getAccountSubdomain(accountId: string): Promise<{ subdomain: string }> {
    return this.request(`/accounts/${accountId}/workers/subdomain`);
  }

  async deleteD1(accountId: string, databaseId: string): Promise<void> {
    await this.request(`/accounts/${accountId}/d1/database/${databaseId}`, { method: "DELETE" });
  }

  async deleteKv(accountId: string, namespaceId: string): Promise<void> {
    await this.request(`/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`, { method: "DELETE" });
  }

  async deleteR2(accountId: string, name: string): Promise<void> {
    await this.request(`/accounts/${accountId}/r2/buckets/${name}`, { method: "DELETE" });
  }

  async deleteWorker(accountId: string, name: string): Promise<void> {
    await this.request(`/accounts/${accountId}/workers/scripts/${name}`, { method: "DELETE" });
  }
}
