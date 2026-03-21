/**
 * Plugin system type contracts.
 *
 * Public types (GsdPluginManifest, GsdPluginContext, GsdPluginFactory) are
 * defined in @gsd/provider-api and re-exported here. Internal types
 * (GsdPluginRecord, PluginLoadResult, etc.) are defined here only.
 */

export type {
  GsdPluginManifest,
  GsdPluginContext,
  GsdPluginFactory,
} from "@gsd/provider-api";

// ─── Plugin Module (ES module shape) ────────────────────────────────────────

import type { GsdPluginFactory } from "@gsd/provider-api";

export interface GsdPluginModule {
  default: GsdPluginFactory;
}

// ─── Internal Tracking ──────────────────────────────────────────────────────

export type GsdPluginState = "discovered" | "loaded" | "active" | "error" | "disabled";

import type { GsdPluginManifest } from "@gsd/provider-api";

export interface GsdPluginRecord {
  id: string;
  state: GsdPluginState;
  manifest: GsdPluginManifest;
  error?: string;
}

// ─── Load Result ────────────────────────────────────────────────────────────

export interface PluginLoadResult {
  loaded: string[];
  errors: Array<{ pluginId: string; message: string }>;
}

// ─── Registry State ─────────────────────────────────────────────────────────

export interface PluginRegistryState {
  plugins: Record<string, { enabled: boolean }>;
}
