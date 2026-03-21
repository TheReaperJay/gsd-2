/**
 * Plugin system type contracts.
 *
 * Defines the manifest format, plugin context, factory signature,
 * and internal tracking records for the GSD plugin system.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { GsdProviderInfo, GsdProviderDeps, GsdToolDef } from "../provider-api/types.js";

// ─── Plugin Manifest (plugin.json) ──────────────────────────────────────────

export interface GsdPluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  type: "provider" | "tools" | "extension";
  capabilities?: {
    provider?: boolean;
    tools?: boolean;
    commands?: boolean;
    hooks?: boolean;
    onboarding?: boolean;
  };
  provider?: {
    id: string;
    displayName: string;
    defaultModel?: string;
    authType: "cli" | "api-key" | "oauth" | "none";
  };
  dependencies?: {
    runtime?: string[];
    npm?: Record<string, string>;
  };
  platform?: {
    node?: string;
  };
}

// ─── Plugin Context (passed to plugin factory) ──────────────────────────────

export interface GsdPluginContext {
  pi: ExtensionAPI;
  pluginDir: string;
  manifest: GsdPluginManifest;
  log(level: "info" | "warn" | "error" | "debug", message: string): void;
  provider: {
    registerProviderInfo(info: GsdProviderInfo): void;
    registerGsdTool(def: GsdToolDef): void;
    wireProvidersToPI(): Promise<void>;
    setProviderDeps(deps: GsdProviderDeps): void;
    getProviderDeps(): GsdProviderDeps | null;
  };
}

// ─── Plugin Factory ─────────────────────────────────────────────────────────

export type GsdPluginFactory = (ctx: GsdPluginContext) => void | Promise<void>;

// ─── Plugin Module (ES module shape) ────────────────────────────────────────

export interface GsdPluginModule {
  default: GsdPluginFactory;
}

// ─── Internal Tracking ──────────────────────────────────────────────────────

export type GsdPluginState = "discovered" | "loaded" | "active" | "error" | "disabled";

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
