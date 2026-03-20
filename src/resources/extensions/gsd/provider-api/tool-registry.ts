/**
 * GSD tool registry — shared tool definitions that any provider can consume.
 *
 * GSD core calls registerGsdTool() during extension init.
 * Providers call getGsdTools() when creating their tool/MCP server.
 */

import type { GsdToolDef } from "./types.js";

const registry: GsdToolDef[] = [];

export function registerGsdTool(def: GsdToolDef): void {
  registry.push(def);
}

export function getGsdTools(): readonly GsdToolDef[] {
  return registry;
}
