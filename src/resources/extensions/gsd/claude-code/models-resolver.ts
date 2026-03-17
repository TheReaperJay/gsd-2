// GSD Extension — Claude Code Models Resolver
// Maps GSD model IDs to Claude Code aliases and complexity tiers to SDK
// thinking/effort configurations. Single source of truth for model routing
// when the claude-code provider is active.

import type { ComplexityTier } from '../complexity-classifier.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** SDK configuration passed to query() options when using the claude-code provider. */
export interface SdkModelConfig {
  /** Claude Code model alias: "opus" | "sonnet" | "haiku" */
  model: string;
  /** Effort level — controls compute budget. 'max' is intentionally excluded per locked decision. */
  effort: 'low' | 'medium' | 'high';
  /** Thinking configuration — controls extended reasoning. */
  thinking: { type: 'disabled' } | { type: 'enabled' };
}

// ─── Model Alias Mapping ──────────────────────────────────────────────────────

/**
 * Maps known GSD model IDs to Claude Code model aliases.
 * Claude Code accepts short aliases ("opus", "sonnet", "haiku") rather than
 * full model IDs. This table covers all Anthropic models in MODEL_CAPABILITY_TIER
 * from model-router.ts.
 */
const GSD_TO_CLAUDE_CODE_ALIAS: Record<string, string> = {
  'claude-opus-4-6': 'opus',
  'claude-3-opus-latest': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-sonnet-4-5-20250514': 'sonnet',
  'claude-3-5-sonnet-latest': 'sonnet',
  'claude-haiku-4-5': 'haiku',
  'claude-3-5-haiku-latest': 'haiku',
  'claude-3-haiku-20240307': 'haiku',
};

/**
 * Resolves a GSD model ID to the Claude Code model alias used in SDK query options.
 *
 * Falls back to "sonnet" for unknown model IDs — the standard tier is the
 * safest default: capable enough for most tasks, not wastefully expensive.
 *
 * @param gsdModelId - A full GSD model ID (e.g., "claude-opus-4-6")
 * @returns Claude Code alias: "opus" | "sonnet" | "haiku"
 */
export function resolveClaudeCodeAlias(gsdModelId: string): string {
  return GSD_TO_CLAUDE_CODE_ALIAS[gsdModelId] ?? 'sonnet';
}

// ─── Tier Config Mapping ──────────────────────────────────────────────────────

/**
 * Maps GSD complexity tiers to SDK model+effort+thinking configurations.
 * These values are LOCKED per CONTEXT.md — do not use 'max' for effort.
 *
 * - light:    Cheapest path — haiku with no thinking overhead
 * - standard: Balanced path — sonnet with thinking enabled at medium effort
 * - heavy:    Most capable path — opus with thinking enabled at high effort
 */
const TIER_SDK_CONFIG: Record<ComplexityTier, SdkModelConfig> = {
  light:    { model: 'haiku',  effort: 'low',    thinking: { type: 'disabled' } },
  standard: { model: 'sonnet', effort: 'medium', thinking: { type: 'enabled' } },
  heavy:    { model: 'opus',   effort: 'high',   thinking: { type: 'enabled' } },
};

/**
 * Returns the SDK model configuration for a given GSD complexity tier.
 *
 * @param tier - GSD complexity tier from the classifier
 * @returns SDK config with model alias, effort level, and thinking configuration
 */
export function getSdkTierConfig(tier: ComplexityTier): SdkModelConfig {
  return TIER_SDK_CONFIG[tier];
}

// ─── Downgrade Ladder ─────────────────────────────────────────────────────────

/**
 * Ordered list of SDK configs for budget-pressure downgrading.
 * Strategy: reduce effort before switching model — preserves capability
 * while reducing token consumption.
 *
 * Usage: start at the index matching the current config, call
 * getDowngradeStep(currentIndex) to get the next step's index.
 *
 * Full ladder:
 *   [0] opus+high   → [1] opus+medium → [2] opus+low
 *   → [3] sonnet+medium → [4] sonnet+low → [5] haiku+low (floor)
 */
export const DOWNGRADE_LADDER: readonly SdkModelConfig[] = [
  { model: 'opus',   effort: 'high',   thinking: { type: 'enabled' } },   // 0 — heavy tier start
  { model: 'opus',   effort: 'medium', thinking: { type: 'enabled' } },   // 1
  { model: 'opus',   effort: 'low',    thinking: { type: 'disabled' } },  // 2
  { model: 'sonnet', effort: 'medium', thinking: { type: 'enabled' } },   // 3 — standard tier start
  { model: 'sonnet', effort: 'low',    thinking: { type: 'disabled' } },  // 4
  { model: 'haiku',  effort: 'low',    thinking: { type: 'disabled' } },  // 5 — floor
];

/**
 * Returns the index of the next step down in the downgrade ladder.
 *
 * @param currentIndex - Current position in DOWNGRADE_LADDER (0–5)
 * @returns Next index (currentIndex + 1), or null if already at the floor (index 5)
 */
export function getDowngradeStep(currentIndex: number): number | null {
  const nextIndex = currentIndex + 1;
  if (nextIndex >= DOWNGRADE_LADDER.length) {
    return null;
  }
  return nextIndex;
}

// ─── Escalation Ladder ────────────────────────────────────────────────────────

/**
 * Ordered list of SDK configs for failure-recovery escalation.
 * Strategy: increase effort before switching model — maximizes current model's
 * capability before paying the cost of a larger model.
 *
 * Usage: start at the index matching the current config, call
 * getEscalationStep(currentIndex) to get the next step's index.
 *
 * Full ladder:
 *   [0] sonnet+medium → [1] sonnet+high → [2] opus+high (ceiling)
 */
export const ESCALATION_LADDER: readonly SdkModelConfig[] = [
  { model: 'sonnet', effort: 'medium', thinking: { type: 'enabled' } },   // 0 — standard tier start
  { model: 'sonnet', effort: 'high',   thinking: { type: 'enabled' } },   // 1
  { model: 'opus',   effort: 'high',   thinking: { type: 'enabled' } },   // 2 — ceiling
];

/**
 * Returns the index of the next step up in the escalation ladder.
 *
 * @param currentIndex - Current position in ESCALATION_LADDER (0–2)
 * @returns Next index (currentIndex + 1), or null if already at the ceiling (index 2)
 */
export function getEscalationStep(currentIndex: number): number | null {
  const nextIndex = currentIndex + 1;
  if (nextIndex >= ESCALATION_LADDER.length) {
    return null;
  }
  return nextIndex;
}
