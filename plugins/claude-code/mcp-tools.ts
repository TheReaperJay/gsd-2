/**
 * Generic MCP server factory — reads tools from the shared registry.
 *
 * Zero GSD knowledge. This module only knows about the SDK's MCP API
 * and the provider-api tool registry interface.
 */

import { getGsdTools } from "@gsd/provider-api";

export async function createMcpServerFromRegistry() {
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const gsdTools = getGsdTools();

  if (gsdTools.length === 0) return undefined;

  return createSdkMcpServer({
    name: "gsd-tools",
    version: "1.0.0",
    tools: gsdTools.map((t) => tool(t.name, t.description, t.schema, t.execute)),
  });
}
