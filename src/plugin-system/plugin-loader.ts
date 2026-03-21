/**
 * Plugin loader — discovers, validates, and activates plugins.
 *
 * Called once from GSD's register-extension.ts after all standard GSD
 * registration is complete. If no plugins are installed, this is a no-op.
 *
 * Plugins are raw .ts files loaded via jiti at runtime — no build step
 * required. jiti handles TypeScript transpilation, .ts extension resolution,
 * and module resolution (including workspace packages like @gsd/provider-api).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { GsdPluginManifest, GsdPluginModule, PluginLoadResult } from "./types.js";
import { discoverPlugins, getPluginsDir } from "./plugin-discovery.js";
import { registerPlugin } from "./plugin-registry.js";
import { createPluginContext } from "./plugin-context-factory.js";
import { wireProvidersToPI } from "@gsd/provider-api";
import { readRegistryState } from "./plugin-state.js";

const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true, debug: false });

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
 * Load and activate a single plugin by ID from its installed directory.
 *
 * This exists so plugins can be hot-loaded after install without restarting
 * GSD. We cannot re-run loadPlugins() for this because wireProvidersToPI()
 * registers pi.on("agent_start") / pi.on("agent_end") event listeners
 * every time it's called — re-running it stacks duplicate listeners that
 * never get cleaned up. Instead, we load just the new plugin and let its
 * own factory (which calls ctx.provider.wireProvidersToPI()) handle the
 * Pi wiring for its own provider only.
 */
export async function loadSinglePlugin(
  pi: ExtensionAPI,
  pluginId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const pluginDir = join(getPluginsDir(), pluginId);
  const manifestPath = join(pluginDir, "plugin.json");

  if (!existsSync(manifestPath)) {
    return { ok: false, message: `Plugin directory not found: ${pluginDir}` };
  }

  let manifest: GsdPluginManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as GsdPluginManifest;
  } catch {
    return { ok: false, message: `Invalid plugin.json in ${pluginDir}` };
  }

  if (manifest.dependencies?.runtime?.length) {
    const check = checkRuntimeDeps(manifest.dependencies.runtime);
    if (!check.ok) {
      const msg = `Missing runtime dependencies: ${check.missing.join(", ")}`;
      registerPlugin({ id: manifest.id, state: "error", manifest, error: msg });
      return { ok: false, message: msg };
    }
  }

  const entryPath = join(pluginDir, manifest.entry);
  if (!existsSync(entryPath)) {
    return { ok: false, message: `Entry point not found: ${manifest.entry}` };
  }

  try {
    const mod = await jiti.import(entryPath, {}) as GsdPluginModule;
    if (typeof mod.default !== "function") {
      throw new Error("Entry point must export a default function");
    }

    const ctx = createPluginContext(pi, manifest, pluginDir);
    await mod.default(ctx);

    registerPlugin({ id: manifest.id, state: "active", manifest });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    registerPlugin({ id: manifest.id, state: "error", manifest, error: msg });
    return { ok: false, message: msg };
  }
}

/**
 * Load all enabled plugins and wire their providers to Pi.
 */
export async function loadPlugins(pi: ExtensionAPI): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { loaded: [], errors: [] };

  const discovered = discoverPlugins();
  if (discovered.length === 0) return result;

  const registryState = readRegistryState();

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

      const mod = await jiti.import(entryPath, {}) as GsdPluginModule;
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
