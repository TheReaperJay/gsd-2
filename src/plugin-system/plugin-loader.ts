/**
 * Plugin loader — discovers, validates, and activates plugins.
 *
 * Called once from GSD's register-extension.ts after all standard GSD
 * registration is complete. If no plugins are installed, this is a no-op.
 */

import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { GsdPluginModule, PluginLoadResult } from "./types.js";
import { discoverPlugins, getPluginsDir } from "./plugin-discovery.js";
import { registerPlugin } from "./plugin-registry.js";
import { createPluginContext } from "./plugin-context-factory.js";
import { wireProvidersToPI } from "../provider-api/adapter.js";
import { readRegistryState } from "./plugin-state.js";

/**
 * Ensure plugins can resolve shared packages (zod, @gsd/* types, etc.)
 * by symlinking ~/.gsd/plugins/node_modules → <gsd-root>/node_modules.
 */
function ensureSharedNodeModules(): void {
  const pluginsDir = getPluginsDir();
  const link = join(pluginsDir, "node_modules");

  // Find GSD root's node_modules from this file's compiled location
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const gsdRoot = join(thisDir, "..");
  const target = join(gsdRoot, "node_modules");

  if (!existsSync(target)) return;

  try {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink()) return; // already linked
  } catch {
    // doesn't exist — create it
  }

  try {
    symlinkSync(target, link, "junction");
  } catch {
    // non-fatal — plugins may fail to resolve shared deps
  }
}

/**
 * Check that runtime dependencies (CLI binaries) are available.
 */
function checkRuntimeDeps(deps: string[]): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const cmd of deps) {
    const result = spawnSync(cmd, ["--version"], { encoding: "utf-8", timeout: 5000 });
    if (result.error || result.status !== 0) {
      missing.push(cmd);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Load all enabled plugins and wire their providers to Pi.
 */
export async function loadPlugins(pi: ExtensionAPI): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { loaded: [], errors: [] };

  const discovered = discoverPlugins();
  if (discovered.length === 0) return result;

  const registryState = readRegistryState();
  ensureSharedNodeModules();

  for (const { manifest, pluginDir } of discovered) {
    // Check enable/disable state
    const pluginState = registryState.plugins[manifest.id];
    if (pluginState && !pluginState.enabled) {
      registerPlugin({ id: manifest.id, state: "disabled", manifest });
      continue;
    }

    // Check runtime dependencies
    if (manifest.dependencies?.runtime?.length) {
      const check = checkRuntimeDeps(manifest.dependencies.runtime);
      if (!check.ok) {
        const msg = `Missing runtime dependencies: ${check.missing.join(", ")}`;
        registerPlugin({ id: manifest.id, state: "error", manifest, error: msg });
        result.errors.push({ pluginId: manifest.id, message: msg });
        continue;
      }
    }

    // Load and activate
    try {
      const entryPath = join(pluginDir, manifest.entry);
      if (!existsSync(entryPath)) {
        throw new Error(`Entry point not found: ${manifest.entry}`);
      }

      const mod = await import(entryPath) as GsdPluginModule;
      if (typeof mod.default !== "function") {
        throw new Error(`Entry point must export a default function`);
      }

      const ctx = createPluginContext(pi, manifest, pluginDir);
      await mod.default(ctx);

      registerPlugin({ id: manifest.id, state: "active", manifest });
      result.loaded.push(manifest.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      registerPlugin({ id: manifest.id, state: "error", manifest, error: msg });
      result.errors.push({ pluginId: manifest.id, message: msg });
    }
  }

  // Wire all registered providers to Pi after all plugins have loaded
  if (result.loaded.length > 0) {
    await wireProvidersToPI(pi);
  }

  return result;
}
