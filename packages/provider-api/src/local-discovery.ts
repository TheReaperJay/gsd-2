/**
 * Local provider discovery — scans for provider directories and imports them.
 *
 * Convention: any subdirectory of a provider location that contains an
 * info.ts/info.js file is treated as a provider. The info module
 * self-registers via registerProviderInfo() as a side effect of import.
 *
 * Scan order: extensions -> providers -> project-local providers.
 * Because registerProviderInfo() upserts by ID, the last write wins — project-local
 * providers override global providers on ID conflict.
 *
 * Directories without info files are silently skipped (not every subdirectory
 * is a provider). Import failures for directories that DO have info files
 * are logged to stderr but never crash startup.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true, debug: false });

/** Directories that are never providers. */
const SKIP = new Set(["tests", "prompts", "node_modules"]);

/**
 * Discover and import local provider info modules.
 *
 * Scans in order: ~/.gsd/agent/extensions/ (bundled + installed extensions),
 * ~/.gsd/providers/ (global providers), and (if projectRoot provided)
 * project-local .gsd/providers/. Project-local providers override global
 * providers on ID conflict via upsert semantics.
 *
 * The extensions/ scan runs BEFORE extensions fully load via Pi (which
 * happens in createAgentSession). This allows provider extensions to
 * participate in onboarding by registering their GsdProviderInfo early
 * via info.ts side-effect imports.
 *
 * Returns the list of successfully loaded provider directory names.
 */
export async function discoverLocalProviders(projectRoot?: string): Promise<string[]> {
  const loaded: string[] = [];

  const locations: string[] = [
    join(homedir(), ".gsd", "agent", "extensions"), // bundled + installed extensions
    join(homedir(), ".gsd", "providers"),            // global providers
  ];
  if (projectRoot) {
    locations.push(join(projectRoot, ".gsd", "providers")); // project-local (wins on ID conflict)
  }

  for (const location of locations) {
    let entries: string[];
    try {
      entries = readdirSync(location).filter(name => {
        if (SKIP.has(name)) return false;
        try { return statSync(join(location, name)).isDirectory(); }
        catch { return false; }
      });
    } catch { continue; }

    for (const dir of entries) {
      const dirPath = join(location, dir);

      // Detect whether the directory has info.ts (jiti) or info.js (compiled)
      let infoFile: string | null = null;
      try {
        const files = readdirSync(dirPath);
        if (files.includes("info.ts")) infoFile = "info.ts";
        else if (files.includes("info.js")) infoFile = "info.js";
      } catch { continue; }

      if (!infoFile) continue;

      try {
        await jiti.import(join(dirPath, infoFile), {});
        loaded.push(dir);
      } catch (err) {
        process.stderr.write(
          `[gsd] Failed to load provider from ${dir}/info: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  return loaded;
}
