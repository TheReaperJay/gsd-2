/**
 * GSD Provider Registry — shared registration point for GSD provider plugins.
 *
 * Providers call registerProviderInfo() to declare themselves. GSD core reads
 * the registry for onboarding discovery.
 *
 * Storage uses globalThis[Symbol.for()] so that both compiled (dist/) and
 * jiti-loaded (extensions/) module contexts share the same backing array.
 */

import type { GsdProviderInfo, GsdProviderDeps } from "./types.js";

const REGISTRY_KEY = Symbol.for("gsd-provider-registry");
const DEPS_KEY = Symbol.for("gsd-provider-deps");

function getRegistry(): GsdProviderInfo[] {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = [];
  return g[REGISTRY_KEY] as GsdProviderInfo[];
}

function getStoredDeps(): { value: GsdProviderDeps | null } {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[DEPS_KEY]) g[DEPS_KEY] = { value: null };
  return g[DEPS_KEY] as { value: GsdProviderDeps | null };
}

/** Register a provider's static info. Called by any provider (bundled or external). */
export function registerProviderInfo(info: GsdProviderInfo): void {
  const registry = getRegistry();
  const existing = registry.findIndex(p => p.id === info.id);
  if (existing >= 0) registry[existing] = info;
  else registry.push(info);
}

/** Read all registered provider infos. Used by onboarding and GSD core. */
export function getRegisteredProviderInfos(): readonly GsdProviderInfo[] {
  return getRegistry();
}

/** Store GSD provider deps. Called by GSD's extension factory during init. */
export function setProviderDeps(deps: GsdProviderDeps): void {
  getStoredDeps().value = deps;
}

/** Read stored deps. Used by external providers for lazy dep resolution. */
export function getProviderDeps(): GsdProviderDeps | null {
  return getStoredDeps().value;
}

/** Remove a provider info entry by ID. Used by add-provider validation cleanup. */
export function removeProviderInfo(id: string): boolean {
  const registry = getRegistry();
  const idx = registry.findIndex(p => p.id === id);
  if (idx >= 0) {
    registry.splice(idx, 1);
    return true;
  }
  return false;
}
