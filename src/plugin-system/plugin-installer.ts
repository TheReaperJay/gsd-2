/**
 * Plugin installer — add, remove, enable, disable plugins.
 *
 * Handles fetching from npm/git/local, validating plugin.json,
 * installing npm dependencies, and managing registry state.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { GsdPluginManifest } from "./types.js";
import { getPluginsDir } from "./plugin-discovery.js";
import { setPluginEnabled, readRegistryState, writeRegistryState } from "./plugin-state.js";

function detectSourceType(source: string): "npm" | "git" | "local" {
  if (source.startsWith("git@") || source.startsWith("https://") || source.startsWith("git://")) return "git";
  if (existsSync(resolve(source))) return "local";
  return "npm";
}

function fetchToTemp(source: string, sourceType: "npm" | "git" | "local"): string {
  const tempDir = join(tmpdir(), `gsd-plugin-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  switch (sourceType) {
    case "local":
      cpSync(resolve(source), tempDir, { recursive: true });
      break;
    case "git":
      execSync(`git clone --depth 1 ${source} ${tempDir}`, { encoding: "utf-8", stdio: "pipe" });
      break;
    case "npm":
      execSync(`npm pack ${source} --pack-destination ${tempDir}`, { encoding: "utf-8", stdio: "pipe" });
      const tarball = readdirSync(tempDir).find(f => f.endsWith(".tgz"));
      if (!tarball) throw new Error(`npm pack produced no tarball for ${source}`);
      execSync(`tar -xzf ${join(tempDir, tarball)} -C ${tempDir}`, { encoding: "utf-8", stdio: "pipe" });
      const packageDir = join(tempDir, "package");
      if (existsSync(packageDir)) {
        const files = readdirSync(packageDir);
        for (const f of files) {
          cpSync(join(packageDir, f), join(tempDir, f), { recursive: true });
        }
        rmSync(packageDir, { recursive: true, force: true });
      }
      const tgzPath = join(tempDir, tarball);
      if (existsSync(tgzPath)) rmSync(tgzPath);
      break;
  }

  return tempDir;
}

function findManifest(dir: string): GsdPluginManifest {
  const manifestPath = join(dir, "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No plugin.json found in ${dir}`);
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));

  if (!raw.id || !raw.name || !raw.version || !raw.entry || !raw.type) {
    throw new Error("plugin.json missing required fields (id, name, version, entry, type)");
  }

  return raw as GsdPluginManifest;
}

export function installPlugin(source: string): { manifest: GsdPluginManifest; pluginDir: string } {
  const sourceType = detectSourceType(source);
  const tempDir = fetchToTemp(source, sourceType);

  try {
    const manifest = findManifest(tempDir);
    const pluginsDir = getPluginsDir();
    const pluginDir = join(pluginsDir, manifest.id);

    if (existsSync(pluginDir)) {
      throw new Error(`Plugin "${manifest.id}" is already installed at ${pluginDir}. Remove it first.`);
    }

    mkdirSync(pluginsDir, { recursive: true });
    cpSync(tempDir, pluginDir, { recursive: true });

    // Install npm dependencies if declared
    if (manifest.dependencies?.npm && Object.keys(manifest.dependencies.npm).length > 0) {
      const pkgJsonPath = join(pluginDir, "package.json");
      if (!existsSync(pkgJsonPath)) {
        const pkgJson = {
          name: `gsd-plugin-${manifest.id}`,
          private: true,
          dependencies: manifest.dependencies.npm,
        };
        const { writeFileSync } = require("node:fs");
        writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
      }
      execSync("npm install --production", { cwd: pluginDir, encoding: "utf-8", stdio: "pipe" });
    }

    return { manifest, pluginDir };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function removePlugin(id: string): boolean {
  const pluginDir = join(getPluginsDir(), id);
  if (!existsSync(pluginDir)) return false;

  rmSync(pluginDir, { recursive: true, force: true });

  const state = readRegistryState();
  delete state.plugins[id];
  writeRegistryState(state);

  return true;
}

export function enablePlugin(id: string): boolean {
  const pluginDir = join(getPluginsDir(), id);
  if (!existsSync(pluginDir)) return false;
  setPluginEnabled(id, true);
  return true;
}

export function disablePlugin(id: string): boolean {
  const pluginDir = join(getPluginsDir(), id);
  if (!existsSync(pluginDir)) return false;
  setPluginEnabled(id, false);
  return true;
}

export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  type: string;
  enabled: boolean;
  dir: string;
}

export function listPlugins(): PluginListEntry[] {
  const pluginsDir = getPluginsDir();
  if (!existsSync(pluginsDir)) return [];

  const registryState = readRegistryState();
  const results: PluginListEntry[] = [];

  let entries: string[];
  try {
    entries = readdirSync(pluginsDir).filter(name => {
      if (name === "node_modules" || name === "registry.json") return false;
      try { return require("node:fs").statSync(join(pluginsDir, name)).isDirectory(); }
      catch { return false; }
    });
  } catch { return []; }

  for (const dir of entries) {
    const manifestPath = join(pluginsDir, dir, "plugin.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as GsdPluginManifest;
      const state = registryState.plugins[manifest.id];
      results.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        type: manifest.type,
        enabled: state ? state.enabled : true,
        dir: join(pluginsDir, dir),
      });
    } catch { continue; }
  }

  return results;
}
