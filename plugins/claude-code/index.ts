/**
 * Claude Code plugin entry point.
 *
 * Loaded by the GSD plugin system. Registers the Claude Code provider
 * and wires it to Pi for streaming.
 */

import type { GsdPluginContext } from "@gsd/provider-api";

export default async function(ctx: GsdPluginContext): Promise<void> {
  // Import triggers registerProviderInfo() side effect
  await import("./info.js");

  // Wire provider to Pi so models appear in model registry
  await ctx.provider.wireProvidersToPI();

  ctx.log("info", "Claude Code provider loaded (3 models)");
}
