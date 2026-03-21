/**
 * Gemini CLI plugin entry point.
 *
 * Loaded by the GSD plugin system. Registers the Gemini CLI provider
 * and wires it to Pi for streaming.
 */

import type { GsdPluginContext } from "@gsd/provider-api";

export default async function(ctx: GsdPluginContext): Promise<void> {
  await import("./info.ts");
  await ctx.provider.wireProvidersToPI();
  ctx.log("info", "Gemini CLI provider loaded (3 models)");
}
