/**
 * Plugin registry — tracks loaded plugin state.
 *
 * Uses globalThis[Symbol.for()] so both compiled (dist/) and jiti-loaded
 * module contexts share the same backing array.
 */

import type { GsdPluginRecord } from "./types.js";

const PLUGIN_REGISTRY_KEY = Symbol.for("gsd-plugin-registry");

function getRegistry(): GsdPluginRecord[] {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[PLUGIN_REGISTRY_KEY]) g[PLUGIN_REGISTRY_KEY] = [];
  return g[PLUGIN_REGISTRY_KEY] as GsdPluginRecord[];
}

export function registerPlugin(record: GsdPluginRecord): void {
  const registry = getRegistry();
  const existing = registry.findIndex(p => p.id === record.id);
  if (existing >= 0) registry[existing] = record;
  else registry.push(record);
}

export function getPlugins(): readonly GsdPluginRecord[] {
  return getRegistry();
}

export function getPluginById(id: string): GsdPluginRecord | undefined {
  return getRegistry().find(p => p.id === id);
}

export function removePlugin(id: string): boolean {
  const registry = getRegistry();
  const idx = registry.findIndex(p => p.id === id);
  if (idx >= 0) {
    registry.splice(idx, 1);
    return true;
  }
  return false;
}
