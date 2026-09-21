import { describe, it, expect, vi, afterEach } from "vitest";
import { mcpListTools, mcpCallTool, mcpToolDefinitions } from "../src/server/mcp";

const sseResponse = (payload: unknown) => ({
  ok: true,
  text: async () => `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
});

describe("mcp client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses SSE-framed tools/list responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "echo", description: "Echoes input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tools = await mcpListTools("https://example.test/mcp");
    expect(tools).toEqual([{ name: "echo", description: "Echoes input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/mcp",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"method":"tools/list"') }),
    );
  });

  it("parses SSE-framed tools/call responses and joins text content", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      sseResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hello back" }] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await mcpCallTool("https://example.test/mcp", "echo", { text: "hello" });
    expect(result).toBe("hello back");
  });

  it("throws on a JSON-RPC error response", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sseResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mcpListTools("https://example.test/mcp")).rejects.toThrow("Method not found");
  });

  it("adapts MCP tools into ToolDefinition objects that call back through mcpCallTool", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "echo", description: "Echoes input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] },
        }),
      )
      .mockResolvedValueOnce(sseResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hello back" }] } }));
    vi.stubGlobal("fetch", fetchMock);

    const defs = await mcpToolDefinitions("https://example.test/mcp");
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("echo");
    expect(defs[0].parameters).toEqual({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });

    const result = await defs[0].execute({ text: "hello" });
    expect(result).toBe("hello back");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
