/**
 * Claude Code provider registration.
 *
 * Self-contained entry point that registers the claude-code provider
 * with Pi. Takes the shared GsdProviderDeps from GSD core and handles
 * all provider-specific wiring: ctx capture, model alias mapping, MCP
 * server creation, and streamSimple factory.
 *
 * Zero GSD knowledge — this module only knows about Pi's extension API,
 * the SDK, and the shared provider-api contracts.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { GsdProviderDeps } from "../provider-api/types.js";
import { createClaudeCodeStream } from "./stream-adapter.js";
import type { StreamAdapterDeps } from "./stream-adapter.js";
import { createMcpServerFromRegistry } from "./mcp-tools.js";

const SDK_MODEL_ALIASES: Record<string, string> = {
  "claude-code:claude-opus-4-6": "opus",
  "claude-code:claude-sonnet-4-6": "sonnet",
  "claude-code:claude-haiku-4-5": "haiku",
};

export function registerClaudeCodeProvider(pi: ExtensionAPI, deps: GsdProviderDeps): void {
  let currentCtx: ExtensionContext | null = null;
  pi.on("agent_start", async (_event, ctx) => { currentCtx = ctx; });
  pi.on("agent_end", async () => { currentCtx = null; });

  const fullDeps: StreamAdapterDeps = {
    ...deps,
    getCtx: () => currentCtx,
    resolveModelAlias: (modelId: string) => SDK_MODEL_ALIASES[modelId] ?? "sonnet",
    createMcpServer: createMcpServerFromRegistry,
  };

  pi.registerProvider("claude-code", {
    api: "claude-code" as never,
    baseUrl: "claude-code:",
    apiKey: "claude-code",
    streamSimple: createClaudeCodeStream(fullDeps),
    models: [
      {
        id: "claude-code:claude-opus-4-6",
        name: "Claude Opus 4.6",
        api: "claude-code" as never,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-code:claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "claude-code" as never,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16000,
      },
      {
        id: "claude-code:claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        api: "claude-code" as never,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8096,
      },
    ],
  });
}
