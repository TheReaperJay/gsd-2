/**
 * GSD Extensions Command — /gsd extensions
 *
 * Manage the extension registry: list, enable, disable, info, install, remove.
 * Self-contained — no imports outside the extensions tree (extensions are loaded
 * via jiti at runtime from ~/.gsd/agent/, not compiled by tsc).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { tmpdir } from "node:os";

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");

// ─── Types (mirrored from extension-registry.ts) ────────────────────────────

interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  tier: "core" | "bundled" | "community";
  requires: { platform: string };
  provides?: {
    tools?: string[];
    commands?: string[];
    hooks?: string[];
    shortcuts?: string[];
    provider?: {
      id: string;
      authType: string;
      defaultModel?: string;
    };
  };
  dependencies?: {
    extensions?: string[];
    runtime?: string[];
  };
}

interface ExtensionRegistryEntry {
  id: string;
  enabled: boolean;
  source: "bundled" | "user" | "project";
  disabledAt?: string;
  disabledReason?: string;
}

interface ExtensionRegistry {
  version: 1;
  entries: Record<string, ExtensionRegistryEntry>;
}

// ─── Registry I/O ───────────────────────────────────────────────────────────

function getRegistryPath(): string {
  return join(gsdHome, "extensions", "registry.json");
}

function getAgentExtensionsDir(): string {
  return join(gsdHome, "agent", "extensions");
}

function loadRegistry(): ExtensionRegistry {
  const filePath = getRegistryPath();
  try {
    if (!existsSync(filePath)) return { version: 1, entries: {} };
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && parsed.version === 1 && typeof parsed.entries === "object") {
      return parsed as ExtensionRegistry;
    }
    return { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveRegistry(registry: ExtensionRegistry): void {
  const filePath = getRegistryPath();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
    renameSync(tmp, filePath);
  } catch { /* non-fatal */ }
}

function isEnabled(registry: ExtensionRegistry, id: string): boolean {
  const entry = registry.entries[id];
  if (!entry) return true;
  return entry.enabled;
}

function readManifest(dir: string): ExtensionManifest | null {
  const mPath = join(dir, "extension-manifest.json");
  if (!existsSync(mPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(mPath, "utf-8"));
    if (typeof raw?.id === "string" && typeof raw?.name === "string") return raw as ExtensionManifest;
    return null;
  } catch {
    return null;
  }
}

function discoverManifests(): Map<string, ExtensionManifest> {
  const extDir = getAgentExtensionsDir();
  const manifests = new Map<string, ExtensionManifest>();
  if (!existsSync(extDir)) return manifests;
  for (const entry of readdirSync(extDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = readManifest(join(extDir, entry.name));
    if (m) manifests.set(m.id, m);
  }
  return manifests;
}

// ─── Install helpers ────────────────────────────────────────────────────────

function detectSourceType(source: string): "npm" | "git" | "local" {
  if (source.startsWith("git@") || source.startsWith("https://") || source.startsWith("git://")) return "git";
  if (existsSync(resolve(source))) return "local";
  return "npm";
}

function fetchToTemp(source: string, sourceType: "npm" | "git" | "local"): string {
  const tempDir = join(tmpdir(), `gsd-ext-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  switch (sourceType) {
    case "local":
      cpSync(resolve(source), tempDir, { recursive: true });
      break;
    case "git":
      execSync(`git clone --depth 1 ${source} ${tempDir}`, { encoding: "utf-8", stdio: "pipe" });
      break;
    case "npm": {
      execSync(`npm pack ${source} --pack-destination ${tempDir}`, { encoding: "utf-8", stdio: "pipe" });
      const tarball = readdirSync(tempDir).find(f => f.endsWith(".tgz"));
      if (!tarball) throw new Error(`npm pack produced no tarball for ${source}`);
      execSync(`tar -xzf ${join(tempDir, tarball)} -C ${tempDir}`, { encoding: "utf-8", stdio: "pipe" });
      const packageDir = join(tempDir, "package");
      if (existsSync(packageDir)) {
        for (const f of readdirSync(packageDir)) {
          cpSync(join(packageDir, f), join(tempDir, f), { recursive: true });
        }
        rmSync(packageDir, { recursive: true, force: true });
      }
      const tgzPath = join(tempDir, tarball);
      if (existsSync(tgzPath)) rmSync(tgzPath);
      break;
    }
  }

  return tempDir;
}

function findManifest(dir: string): ExtensionManifest {
  const manifestPath = join(dir, "extension-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No extension-manifest.json found in ${dir}`);
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));

  if (!raw.id || !raw.name || !raw.version) {
    throw new Error("extension-manifest.json missing required fields (id, name, version)");
  }

  return raw as ExtensionManifest;
}

// ─── Command Handler ────────────────────────────────────────────────────────

export async function handleExtensions(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);
  const subCmd = parts[0] ?? "list";

  if (subCmd === "list") {
    handleList(ctx);
    return;
  }

  if (subCmd === "enable") {
    handleEnable(parts[1], ctx);
    return;
  }

  if (subCmd === "disable") {
    handleDisable(parts[1], parts.slice(2).join(" "), ctx);
    return;
  }

  if (subCmd === "info") {
    handleInfo(parts[1], ctx);
    return;
  }

  if (subCmd === "install") {
    await handleInstall(parts.slice(1).join(" "), ctx, pi);
    return;
  }

  if (subCmd === "remove") {
    handleRemove(parts[1], ctx);
    return;
  }

  ctx.ui.notify(
    `Unknown: /gsd extensions ${subCmd}. Usage: /gsd extensions [list|enable|disable|info|install|remove]`,
    "warning",
  );
}

function handleList(ctx: ExtensionCommandContext): void {
  const manifests = discoverManifests();
  const registry = loadRegistry();

  if (manifests.size === 0) {
    ctx.ui.notify("No extension manifests found.", "warning");
    return;
  }

  // Sort: core first, then alphabetical
  const sorted = [...manifests.values()].sort((a, b) => {
    if (a.tier === "core" && b.tier !== "core") return -1;
    if (b.tier === "core" && a.tier !== "core") return 1;
    return a.id.localeCompare(b.id);
  });

  const lines: string[] = [];
  const hdr = padRight("Extensions", 38) + padRight("Status", 10) + padRight("Tier", 12) + padRight("Tools", 7) + "Commands";
  lines.push(hdr);
  lines.push("─".repeat(hdr.length));

  for (const m of sorted) {
    const enabled = isEnabled(registry, m.id);
    const status = enabled ? "enabled" : "disabled";
    const source = registry.entries[m.id]?.source ?? "bundled";
    const tierLabel = source === "user" ? "user" : m.tier;
    const toolCount = m.provides?.tools?.length ?? 0;
    const cmdCount = m.provides?.commands?.length ?? 0;
    const label = `${m.id} (${m.name})`;

    lines.push(
      padRight(label, 38) +
      padRight(status, 10) +
      padRight(tierLabel, 12) +
      padRight(String(toolCount), 7) +
      String(cmdCount),
    );

    if (!enabled) {
      lines.push(`  ↳ gsd extensions enable ${m.id}`);
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

function handleEnable(id: string | undefined, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions enable <id>", "warning");
    return;
  }

  const manifests = discoverManifests();
  if (!manifests.has(id)) {
    ctx.ui.notify(`Extension "${id}" not found. Run /gsd extensions list to see available extensions.`, "warning");
    return;
  }

  const registry = loadRegistry();
  if (isEnabled(registry, id)) {
    ctx.ui.notify(`Extension "${id}" is already enabled.`, "info");
    return;
  }

  const entry = registry.entries[id];
  if (entry) {
    entry.enabled = true;
    delete entry.disabledAt;
    delete entry.disabledReason;
  } else {
    registry.entries[id] = { id, enabled: true, source: "bundled" };
  }
  saveRegistry(registry);
  ctx.ui.notify(`Enabled "${id}". Restart GSD to activate.`, "info");
}

function handleDisable(id: string | undefined, reason: string, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions disable <id>", "warning");
    return;
  }

  const manifests = discoverManifests();
  const manifest = manifests.get(id) ?? null;

  if (!manifests.has(id)) {
    ctx.ui.notify(`Extension "${id}" not found. Run /gsd extensions list to see available extensions.`, "warning");
    return;
  }

  if (manifest?.tier === "core") {
    ctx.ui.notify(`Cannot disable "${id}" — it is a core extension.`, "warning");
    return;
  }

  const registry = loadRegistry();
  if (!isEnabled(registry, id)) {
    ctx.ui.notify(`Extension "${id}" is already disabled.`, "info");
    return;
  }

  const entry = registry.entries[id];
  if (entry) {
    entry.enabled = false;
    entry.disabledAt = new Date().toISOString();
    entry.disabledReason = reason || undefined;
  } else {
    registry.entries[id] = {
      id,
      enabled: false,
      source: "bundled",
      disabledAt: new Date().toISOString(),
      disabledReason: reason || undefined,
    };
  }
  saveRegistry(registry);
  ctx.ui.notify(`Disabled "${id}". Restart GSD to deactivate.`, "info");
}

function handleInfo(id: string | undefined, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions info <id>", "warning");
    return;
  }

  const manifests = discoverManifests();
  const manifest = manifests.get(id);
  if (!manifest) {
    ctx.ui.notify(`Extension "${id}" not found.`, "warning");
    return;
  }

  const registry = loadRegistry();
  const enabled = isEnabled(registry, id);
  const entry = registry.entries[id];

  const lines: string[] = [
    `${manifest.name} (${manifest.id})`,
    "",
    `  Version:     ${manifest.version}`,
    `  Description: ${manifest.description}`,
    `  Tier:        ${manifest.tier}`,
    `  Source:      ${entry?.source ?? "bundled"}`,
    `  Status:      ${enabled ? "enabled" : "disabled"}`,
  ];

  if (entry?.disabledAt) {
    lines.push(`  Disabled at: ${entry.disabledAt}`);
  }
  if (entry?.disabledReason) {
    lines.push(`  Reason:      ${entry.disabledReason}`);
  }

  if (manifest.provides) {
    lines.push("");
    lines.push("  Provides:");
    if (manifest.provides.tools?.length) {
      lines.push(`    Tools:     ${manifest.provides.tools.join(", ")}`);
    }
    if (manifest.provides.commands?.length) {
      lines.push(`    Commands:  ${manifest.provides.commands.join(", ")}`);
    }
    if (manifest.provides.hooks?.length) {
      lines.push(`    Hooks:     ${manifest.provides.hooks.join(", ")}`);
    }
    if (manifest.provides.shortcuts?.length) {
      lines.push(`    Shortcuts: ${manifest.provides.shortcuts.join(", ")}`);
    }
    if (manifest.provides.provider) {
      const p = manifest.provides.provider;
      lines.push(`    Provider:  ${p.id} (${p.authType})`);
      if (p.defaultModel) lines.push(`    Default:   ${p.defaultModel}`);
    }
  }

  if (manifest.dependencies) {
    lines.push("");
    lines.push("  Dependencies:");
    if (manifest.dependencies.extensions?.length) {
      lines.push(`    Extensions: ${manifest.dependencies.extensions.join(", ")}`);
    }
    if (manifest.dependencies.runtime?.length) {
      lines.push(`    Runtime:    ${manifest.dependencies.runtime.join(", ")}`);
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleInstall(source: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (!source) {
    ctx.ui.notify("Usage: /gsd extensions install <npm-package | git-url | local-path>", "warning");
    return;
  }

  let tempDir: string | null = null;
  try {
    // -- Phase 1: Fetch and validate manifest --
    ctx.ui.setWorkingMessage(`Fetching extension from ${source}...`);
    const sourceType = detectSourceType(source);
    tempDir = fetchToTemp(source, sourceType);
    const manifest = findManifest(tempDir);

    // -- Phase 2: Runtime dependency check (D-11, D-12, D-13, D-14) --
    if (manifest.dependencies?.runtime?.length) {
      ctx.ui.setWorkingMessage("Checking runtime dependencies...");
      const missing: string[] = [];
      for (const dep of manifest.dependencies.runtime) {
        const result = spawnSync(dep, ["--version"], { encoding: "utf-8", timeout: 5000 });
        if (result.error || result.status !== 0) {
          missing.push(dep);
        } else {
          ctx.ui.notify(`Dependency found: ${dep}`, "info");
        }
      }
      if (missing.length > 0) {
        ctx.ui.setWorkingMessage();
        ctx.ui.notify(
          `Missing runtime dependencies: ${missing.join(", ")}.\n` +
          `Install them and retry: /gsd extensions install ${source}`,
          "error",
        );
        return;
      }
    }

    // -- Phase 3: Copy extension to target directory --
    ctx.ui.setWorkingMessage(`Installing ${manifest.name}...`);
    const extDir = getAgentExtensionsDir();
    const targetDir = join(extDir, manifest.id);

    if (existsSync(targetDir)) {
      const existingManifest = readManifest(targetDir);
      const registry = loadRegistry();
      const entry = registry.entries[manifest.id];
      if (entry?.source !== "user" && existingManifest) {
        throw new Error(`Extension "${manifest.id}" is a bundled extension and cannot be overwritten. Use a different ID.`);
      }
      rmSync(targetDir, { recursive: true, force: true });
    }

    mkdirSync(extDir, { recursive: true });
    cpSync(tempDir, targetDir, { recursive: true });

    // Install npm dependencies if package.json exists
    const pkgJsonPath = join(targetDir, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
          execSync("npm install --production", { cwd: targetDir, encoding: "utf-8", stdio: "pipe" });
        }
      } catch { /* non-fatal — deps may already be available via GSD's node_modules */ }
    }

    // Register in extension registry as user-installed
    const registry = loadRegistry();
    registry.entries[manifest.id] = { id: manifest.id, enabled: true, source: "user" };
    saveRegistry(registry);

    // -- Phase 4: Hot-load extension (D-01, ONBOARD-01) --
    ctx.ui.setWorkingMessage(`Activating ${manifest.name}...`);
    // Snapshot provider registry before hot-load to detect newly registered providers
    const { getRegisteredProviderInfos } = await import("@gsd/provider-api");
    const beforeIds = new Set(getRegisteredProviderInfos().map(p2 => p2.id));

    // Look for entry file: index.ts first, then index.js
    const entryFile = existsSync(join(targetDir, "index.ts"))
      ? join(targetDir, "index.ts")
      : existsSync(join(targetDir, "index.js"))
        ? join(targetDir, "index.js")
        : null;

    if (entryFile) {
      try {
        const { createJiti } = await import("@mariozechner/jiti");
        const { fileURLToPath } = await import("node:url");
        const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true, debug: false });
        const mod = await jiti.import(entryFile, {}) as { default?: (pi: ExtensionAPI) => Promise<void> };
        if (typeof mod.default === "function") {
          await mod.default(pi);
        }
      } catch (err) {
        ctx.ui.setWorkingMessage();
        ctx.ui.notify(
          `Extension installed but hot-load failed: ${err instanceof Error ? err.message : String(err)}. Restart GSD to activate.`,
          "warning",
        );
      }
    }

    ctx.ui.setWorkingMessage();

    // -- Phase 5: Onboarding dispatch (D-04, D-05, ONBOARD-03) --
    // D-04: Any extension type can declare onboarding. Check for newly registered
    // providers after hot-load — if any have onboard(), call it regardless of
    // manifest type. This is the generic onboarding path.
    //
    // D-05: Only provider extensions get the default CLI auth flow as fallback
    // when they don't declare custom onboard().
    //
    // NOTE on dynamic imports below: ExtensionContext and ExtensionAPI do NOT
    // expose authStorage or settingsManager (verified in types.ts). The only way
    // to obtain them is via dynamic import from @gsd/pi-coding-agent. This is a
    // deliberate deviation from the "self-contained" pattern documented at the top
    // of this file. The alternative would be extending ExtensionContext to expose
    // these, which is a larger architectural change deferred to a future phase.
    // The dynamic imports are safe here because commands-extensions.ts is loaded
    // via jiti at runtime within the GSD process where @gsd/pi-coding-agent is
    // already resolved.

    const afterProviders = getRegisteredProviderInfos();
    const newProviders = afterProviders.filter(p => !beforeIds.has(p.id));

    // Path 1: Extension registered new provider(s) — check for onboard()
    if (newProviders.length > 0) {
      for (const pp of newProviders) {
        if (pp.onboard) {
          // D-04: Generic onboard() dispatch — works for ANY extension type
          const p = await import("@clack/prompts");
          const pcMod = await import("picocolors");
          const pc = pcMod.default;
          const { AuthStorage, getAgentDir } = await import("@gsd/pi-coding-agent");
          const agentDirPath = getAgentDir();
          const authFilePath = join(agentDirPath, "auth.json");
          const authStorage = AuthStorage.create(authFilePath);

          await pp.onboard(p, pc, authStorage);

          ctx.ui.notify(
            `${manifest.name} v${manifest.version} installed and activated.\n` +
            `  Provider: ${pp.displayName}\n` +
            `  Models: ${pp.models.map(m => m.displayName || m.id).join(", ")}`,
            "info",
          );
        } else if (manifest.provides?.provider) {
          // D-05: Provider extension without custom onboard() — run default auth flow
          const { runPluginOnboarding } = await import("@gsd/provider-api");
          const p = await import("@clack/prompts");
          const pcMod = await import("picocolors");
          const pc = pcMod.default;
          const { AuthStorage, SettingsManager, getAgentDir } = await import("@gsd/pi-coding-agent");
          const agentDirPath = getAgentDir();
          const authFilePath = join(agentDirPath, "auth.json");
          const authStorage = AuthStorage.create(authFilePath);
          const settingsManager = SettingsManager.create(agentDirPath);

          const onboardResult = await runPluginOnboarding(pp, p, pc, authStorage, settingsManager);

          // Show summary (D-08, ONBOARD-03)
          const modelNames = pp.models.map(m => m.displayName || m.id).join(", ");
          if (onboardResult.ok) {
            ctx.ui.notify(
              `${manifest.name} v${manifest.version} installed and activated.\n` +
              `  Provider: ${pp.displayName}\n` +
              `  Models: ${modelNames}\n` +
              `  Auth: authenticated` +
              (pp.defaultModel ? `\n  Default: ${pp.defaultModel}` : ""),
              "info",
            );
          } else {
            ctx.ui.notify(
              `${manifest.name} v${manifest.version} installed.\n` +
              `  Provider: ${pp.displayName}\n` +
              `  Models: ${modelNames}\n` +
              `  Auth: not authenticated — models hidden until auth is resolved`,
              "warning",
            );
          }
        } else {
          // Non-provider extension that registered a provider without onboard() — simple success
          ctx.ui.notify(
            `${manifest.name} v${manifest.version} installed and activated.\n` +
            `  Provider: ${pp.displayName}`,
            "info",
          );
        }
      }
    } else {
      // No new providers registered — non-provider extension (D-03)
      ctx.ui.notify(
        `Extension "${manifest.name}" v${manifest.version} installed and activated.`,
        "info",
      );
    }
  } catch (err) {
    ctx.ui.setWorkingMessage();
    ctx.ui.notify(`Failed to install: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    ctx.ui.setWorkingMessage();
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  }
}

function handleRemove(id: string | undefined, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions remove <id>", "warning");
    return;
  }

  const registry = loadRegistry();
  const entry = registry.entries[id];

  if (entry && entry.source !== "user") {
    ctx.ui.notify(`Cannot remove "${id}" — only user-installed extensions can be removed.`, "warning");
    return;
  }

  const extDir = join(getAgentExtensionsDir(), id);
  if (!existsSync(extDir)) {
    ctx.ui.notify(`Extension "${id}" not found.`, "warning");
    return;
  }

  // Verify it's user-installed if no registry entry (safety check)
  if (!entry) {
    const manifest = readManifest(extDir);
    if (manifest && (manifest.tier === "core" || manifest.tier === "bundled")) {
      ctx.ui.notify(`Cannot remove "${id}" — it is a ${manifest.tier} extension.`, "warning");
      return;
    }
  }

  rmSync(extDir, { recursive: true, force: true });
  delete registry.entries[id];
  saveRegistry(registry);

  ctx.ui.notify(`Extension "${id}" removed. Restart GSD for full effect.`, "info");
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str + " " : str + " ".repeat(len - str.length);
}
