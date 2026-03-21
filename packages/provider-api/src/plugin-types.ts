/**
 * Plugin type contracts — exported from @gsd/provider-api so plugins
 * can import them without relative paths.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { GsdProviderInfo, GsdProviderDeps, GsdToolDef } from "./types.js";

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

export type GsdPluginFactory = (ctx: GsdPluginContext) => void | Promise<void>;
