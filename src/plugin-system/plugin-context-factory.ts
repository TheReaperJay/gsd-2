/**
 * Plugin context factory — creates a sandboxed GsdPluginContext for each plugin.
 *
 * Wraps Pi's ExtensionAPI and provider-api functions. Scopes logging
 * to the plugin's namespace.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { GsdPluginContext, GsdPluginManifest } from "./types.js";
import { registerProviderInfo, setProviderDeps, getProviderDeps } from "../provider-api/provider-registry.js";
import { registerGsdTool } from "../provider-api/tool-registry.js";
import { wireProvidersToPI } from "../provider-api/adapter.js";

export function createPluginContext(
  pi: ExtensionAPI,
  manifest: GsdPluginManifest,
  pluginDir: string,
): GsdPluginContext {
  return {
    pi,
    pluginDir,
    manifest,
    log(level, message) {
      if (level === "debug") return;
      process.stderr.write(`[gsd:${manifest.id}] ${message}\n`);
    },
    provider: {
      registerProviderInfo,
      registerGsdTool,
      wireProvidersToPI: () => wireProvidersToPI(pi),
      setProviderDeps,
      getProviderDeps,
    },
  };
}
