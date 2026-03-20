/**
 * Shared contracts for GSD provider integration.
 *
 * These interfaces define the boundary between GSD core and provider
 * implementations (claude-code, codex, gemini, etc.). Providers consume
 * these types; they never import GSD core modules directly.
 */

import type { z } from "zod";

/** Tool definition that any provider can wrap in its own format (SDK MCP, CLI schema, etc.). */
export interface GsdToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  execute: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/**
 * Shared deps contract for all GSD providers.
 *
 * Every provider receives these callbacks from GSD core. They enable
 * supervision (timeouts, write blocking), idle detection (tool tracking),
 * and unit lifecycle awareness without the provider knowing anything
 * about GSD's internals.
 *
 * Note: getCtx is NOT included here — each provider captures Pi's
 * ExtensionContext via pi.on("agent_start") in its own register.ts.
 */
export interface GsdProviderDeps {
  getSupervisorConfig: () => {
    soft_timeout_minutes?: number;
    idle_timeout_minutes?: number;
    hard_timeout_minutes?: number;
  };
  shouldBlockContextWrite: (
    toolName: string,
    inputPath: string,
    milestoneId: string | null,
    depthVerified: boolean,
  ) => { block: boolean; reason?: string };
  getMilestoneId: () => string | null;
  isDepthVerified: () => boolean;
  getIsUnitDone: () => boolean;
  onToolStart: (toolCallId: string) => void;
  onToolEnd: (toolCallId: string) => void;
  getBasePath: () => string;
  getUnitInfo: () => { unitType: string; unitId: string };
}
