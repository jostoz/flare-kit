import type { ToolDefinition } from "./tools";

/**
 * Minimal MCP (Model Context Protocol) client: `tools/list` + `tools/call`
 * against a remote MCP server over its "Streamable HTTP" transport
 * (https://modelcontextprotocol.io — a single POST endpoint per server,
 * JSON-RPC 2.0 request bodies).
 *
 * Deliberately stateless: no `initialize` handshake, no `Mcp-Session-Id`
 * tracking, no SSE-as-a-stream reader. Confirmed live against a real
 * public server (mcpplaygroundonline.com) that both `tools/list` and
 * `tools/call` work as single request/response round trips without a
 * prior `initialize` call — the right shape for a stateless Worker
 * request (no connection to hold open across turns, matching every other
 * "retrieve only what's needed" decision in this codebase). A server that
 * requires session-bound (non-stateless) behavior isn't supported here.
 *
 * The response transport is `text/event-stream` even for a single
 * response (one `event: message` / `data: {...}` frame per call) — parsed
 * as SSE below rather than assumed to be plain JSON.
 */

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

async function callMcp<T>(serverUrl: string, method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(serverUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`MCP server error (${res.status}) calling ${method}`);

  const raw = await res.text();
  // SSE framing: pull the JSON payload out of the first "data: " line,
  // falling back to the raw body for a server that responds with plain
  // JSON instead (some do, despite the streamable-HTTP spec).
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  const payload = dataLine ? dataLine.slice(5).trim() : raw.trim();

  const body = JSON.parse(payload) as JsonRpcResponse<T>;
  if (body.error) throw new Error(`MCP error (${body.error.code}): ${body.error.message}`);
  if (body.result === undefined) throw new Error(`MCP response for ${method} had no result`);
  return body.result;
}

export async function mcpListTools(serverUrl: string): Promise<McpToolDef[]> {
  const result = await callMcp<{ tools: McpToolDef[] }>(serverUrl, "tools/list", {});
  return result.tools;
}

interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export async function mcpCallTool(serverUrl: string, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await callMcp<McpCallResult>(serverUrl, "tools/call", { name, arguments: args });
  const text = (result.content ?? [])
    .map((c) => c.text)
    .filter((t): t is string => Boolean(t))
    .join("\n");
  return text || (result.isError ? "Tool call failed with no error detail." : "Tool call returned no content.");
}

/**
 * Fetches a remote MCP server's tool list and adapts each into this
 * repo's `ToolDefinition` shape so the existing Gemini/DeepSeek
 * tool-calling loop (ai-providers.ts) can call them exactly like
 * `webSearchTool`, with no changes to that loop. Re-fetched per request
 * (no cross-request caching) — MCP tool catalogs can change, and a
 * single request's extra round trip is cheap next to the Neuron/token
 * cost of the chat turn itself.
 */
export async function mcpToolDefinitions(serverUrl: string): Promise<ToolDefinition[]> {
  const tools = await mcpListTools(serverUrl);
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? `MCP tool: ${t.name}`,
    parameters: { type: "object", properties: t.inputSchema.properties ?? {}, required: t.inputSchema.required },
    execute: (args: Record<string, unknown>) => mcpCallTool(serverUrl, t.name, args),
  }));
}
