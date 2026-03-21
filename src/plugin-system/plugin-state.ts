/**
 * Plugin state persistence — reads/writes ~/.gsd/plugins/registry.json.
 *
 * Tracks which plugins are enabled/disabled. Missing file or missing
 * entries default to enabled.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getPluginsDir } from "./plugin-discovery.js";
import type { PluginRegistryState } from "./types.js";

function getRegistryPath(): string {
  return join(getPluginsDir(), "registry.json");
}

export function readRegistryState(): PluginRegistryState {
  const path = getRegistryPath();
  if (!existsSync(path)) return { plugins: {} };

  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof data === "object" && data !== null && typeof data.plugins === "object") {
      return data as PluginRegistryState;
    }
    return { plugins: {} };
  } catch {
    return { plugins: {} };
  }
}

export function writeRegistryState(state: PluginRegistryState): void {
  const path = getRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

export function setPluginEnabled(id: string, enabled: boolean): void {
  const state = readRegistryState();
  if (!state.plugins[id]) state.plugins[id] = { enabled };
  else state.plugins[id].enabled = enabled;
  writeRegistryState(state);
}
