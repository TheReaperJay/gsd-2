/**
 * Shared contracts for GSD provider integration.
 *
 * These interfaces define the boundary between GSD core and provider
 * plugins (claude-code, codex, gemini, etc.). Providers consume
 * these types; they never import GSD core modules directly.
 */

import type { z } from "zod";
import type { spawnSync } from "node:child_process";

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

// ─── Usage ───────────────────────────────────────────────────────────────────

/** Token usage reported at the end of a provider stream. */
export interface GsdUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ─── Events ──────────────────────────────────────────────────────────────────

/** Discriminated union of all events emitted by a provider stream. */
export type GsdEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; detail?: string }
  | { type: "tool_end"; toolCallId: string }
  | { type: "completion"; usage: GsdUsage; stopReason: string }
  | { type: "error"; message: string; category: "rate_limit" | "auth" | "timeout" | "unknown"; retryAfterMs?: number };

/** Async iterable of GsdEvent — the return type of GsdProviderInfo.createStream. */
export type GsdEventStream = AsyncIterable<GsdEvent>;

// ─── Model ───────────────────────────────────────────────────────────────────

/** A model exposed by a GSD provider. */
export interface GsdModel {
  id: string;
  displayName: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

// ─── Stream Context ───────────────────────────────────────────────────────────

/** Context passed to GsdProviderInfo.createStream for each invocation. */
export interface GsdStreamContext {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  tools?: GsdToolDef[];
  supervisorConfig: {
    soft_timeout_minutes?: number;
    idle_timeout_minutes?: number;
    hard_timeout_minutes?: number;
  };
}

// ─── Provider Info ───────────────────────────────────────────────────────────

/** Static metadata + declarative stream factory for a GSD provider. */
export interface GsdProviderInfo {
  /** Provider ID — matches what's passed to pi.registerProvider(). */
  id: string;

  /** Human-readable name for onboarding UI. */
  displayName: string;

  /** How this provider authenticates users. */
  auth: GsdProviderAuth;

  /** Default model ID to set after successful onboarding (e.g., "claude-code:claude-opus-4-6"). */
  defaultModel?: string;

  /** Models available from this provider. */
  models: GsdModel[];

  /** Create a GSD-native event stream for the given context and deps. */
  createStream: (context: GsdStreamContext, deps: GsdProviderDeps) => GsdEventStream;

  /**
   * Custom onboarding flow. If provided, called instead of the default
   * auth-type-driven flow. The provider controls the full UX — prompts,
   * validation, credential storage, everything.
   *
   * Returns true if onboarding succeeded, false if skipped/cancelled.
   *
   * Parameters are typed as unknown because @clack/prompts and picocolors
   * are dynamic imports — provider packages cast to the correct types.
   */
  onboard?: (
    clack: unknown,
    pico: unknown,
    authStorage: unknown,
  ) => Promise<boolean>;
}

/** Discriminated union — each provider declares one auth mechanism. */
export type GsdProviderAuth =
  | GsdProviderAuthCli
  | GsdProviderAuthApiKey
  | GsdProviderAuthOAuth
  | GsdProviderAuthNone;

/** CLI-based providers (Claude Code, Codex, Gemini CLI, etc.). */
export interface GsdProviderAuthCli {
  type: "cli";
  /** Hint shown in onboarding (e.g., "requires claude CLI installed and logged in"). */
  hint: string;
  /** Verify CLI installed + authenticated. Returns result, never throws. */
  check: (spawnFn?: typeof spawnSync) =>
    | { ok: true; email?: string; displayInfo?: string }
    | { ok: false; reason: string; instruction: string };
  /** What to store in auth.json on success. */
  credential: { type: "api_key"; key: string };
}

/** API-key providers (remote VPS, local LLM proxy, etc.). */
export interface GsdProviderAuthApiKey {
  type: "api-key";
  /** Environment variable to check (e.g., "MY_LLM_API_KEY"). */
  envVar?: string;
  /** URL where user gets their key. */
  dashboardUrl?: string;
  /** Prefix validation (e.g., ["sk-"]). */
  keyPrefixes?: string[];
}

/** OAuth providers (delegated to Pi's existing OAuth system). */
export interface GsdProviderAuthOAuth {
  type: "oauth";
  /** The OAuth provider ID already registered with Pi. */
  oauthProviderId: string;
}

/** No-auth providers (local LLM, pre-configured environments, etc.). */
export interface GsdProviderAuthNone {
  type: "none";
  /** Why no auth is needed (shown in onboarding). */
  reason: string;
}
