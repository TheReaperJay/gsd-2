/**
 * GSD tool registry — shared tool definitions that any provider can consume.
 *
 * GSD core calls registerGsdTool() during extension init.
 * Providers call getGsdTools() when creating their tool/MCP server.
 *
 * Storage uses globalThis[Symbol.for()] so that both compiled (dist/) and
 * jiti-loaded (extensions/) module contexts share the same backing array.
 */

import type { GsdToolDef } from "./types.js";

const TOOL_REGISTRY_KEY = Symbol.for("gsd-tool-registry");

function getRegistry(): GsdToolDef[] {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[TOOL_REGISTRY_KEY]) g[TOOL_REGISTRY_KEY] = [];
  return g[TOOL_REGISTRY_KEY] as GsdToolDef[];
}

export function registerGsdTool(def: GsdToolDef): void {
  getRegistry().push(def);
}

export function getGsdTools(): readonly GsdToolDef[] {
  return getRegistry();
}
