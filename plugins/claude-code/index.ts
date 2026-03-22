/**
 * Claude Code extension entry point.
 *
 * Loaded by Pi's extension system. Registers the Claude Code provider
 * and wires it to Pi for streaming.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { wireProvidersToPI } from "@gsd/provider-api";

export default async function(pi: ExtensionAPI): Promise<void> {
  // Import triggers registerProviderInfo() side effect
  await import("./info.ts");

  // Wire registered providers to Pi so models appear in model registry
  await wireProvidersToPI(pi);
}
