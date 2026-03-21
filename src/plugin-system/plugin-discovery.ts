/**
 * Plugin discovery — scans ~/.gsd/plugins/ for plugin directories.
 *
 * Each plugin directory must contain a plugin.json manifest.
 * Discovery is a pure filesystem read — no loading, no imports,
 * no side effects.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GsdPluginManifest } from "./types.js";

const PLUGINS_DIR = join(homedir(), ".gsd", "plugins");

export function getPluginsDir(): string {
  return PLUGINS_DIR;
}

function validateManifest(data: unknown, filePath: string): GsdPluginManifest | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;

  if (typeof obj.id !== "string" || !obj.id) {
    process.stderr.write(`[gsd:plugin] ${filePath}: missing or invalid "id"\n`);
    return null;
  }
  if (typeof obj.name !== "string" || !obj.name) {
    process.stderr.write(`[gsd:plugin] ${filePath}: missing or invalid "name"\n`);
    return null;
  }
  if (typeof obj.version !== "string" || !obj.version) {
    process.stderr.write(`[gsd:plugin] ${filePath}: missing or invalid "version"\n`);
    return null;
  }
  if (typeof obj.entry !== "string" || !obj.entry) {
    process.stderr.write(`[gsd:plugin] ${filePath}: missing or invalid "entry"\n`);
    return null;
  }
  if (obj.type !== "provider" && obj.type !== "tools" && obj.type !== "extension") {
    process.stderr.write(`[gsd:plugin] ${filePath}: "type" must be "provider", "tools", or "extension"\n`);
    return null;
  }

  return data as GsdPluginManifest;
}

/**
 * Discover all plugin manifests from ~/.gsd/plugins/.
 *
 * Scans subdirectories for plugin.json files, parses and validates them.
 * Returns valid manifests with their directory paths. Invalid manifests
 * are logged to stderr and skipped.
 */
export function discoverPlugins(): Array<{ manifest: GsdPluginManifest; pluginDir: string }> {
  if (!existsSync(PLUGINS_DIR)) return [];

  const results: Array<{ manifest: GsdPluginManifest; pluginDir: string }> = [];

  let entries: string[];
  try {
    entries = readdirSync(PLUGINS_DIR).filter(name => {
      if (name === "node_modules") return false;
      try { return statSync(join(PLUGINS_DIR, name)).isDirectory(); }
      catch { return false; }
    });
  } catch { return []; }

  for (const dir of entries) {
    const pluginDir = join(PLUGINS_DIR, dir);
    const manifestPath = join(pluginDir, "plugin.json");

    if (!existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const manifest = validateManifest(raw, manifestPath);
      if (manifest) {
        results.push({ manifest, pluginDir });
      }
    } catch (err) {
      process.stderr.write(
        `[gsd:plugin] Failed to parse ${manifestPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return results;
}
