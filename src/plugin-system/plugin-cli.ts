/**
 * Plugin CLI — handles /gsd plugin commands.
 *
 * Dispatches to: list, add, remove, enable, disable, info
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { installPlugin, removePlugin, enablePlugin, disablePlugin, listPlugins } from "./plugin-installer.js";
import { getPluginById } from "./plugin-registry.js";

export async function handlePlugin(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0] || "list";
  const target = parts.slice(1).join(" ");

  switch (subcommand) {
    case "list":
      return handleList(ctx);
    case "add":
      return handleAdd(target, ctx, pi);
    case "remove":
      return handleRemove(target, ctx);
    case "enable":
      return handleEnable(target, ctx);
    case "disable":
      return handleDisable(target, ctx);
    case "info":
      return handleInfo(target, ctx);
    default:
      ctx.ui.notify(`Unknown plugin command: ${subcommand}. Available: list, add, remove, enable, disable, info`, "warning");
  }
}

function handleList(ctx: ExtensionCommandContext): void {
  const plugins = listPlugins();

  if (plugins.length === 0) {
    ctx.ui.notify("No plugins installed. Use /gsd plugin add <source> to install one.", "info");
    return;
  }

  const lines = ["**Installed Plugins**", ""];
  for (const p of plugins) {
    const status = p.enabled ? "active" : "disabled";
    lines.push(`  ${p.enabled ? "✓" : "✗"} **${p.name}** v${p.version} (${p.type}) — ${status}`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleAdd(source: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (!source) {
    ctx.ui.notify("Usage: /gsd plugin add <npm-package | git-url | local-path>", "warning");
    return;
  }

  ctx.ui.notify(`Installing plugin from: ${source}...`, "info");

  try {
    const { manifest } = installPlugin(source);
    const { loadSinglePlugin } = await import("./plugin-loader.js");
    const loadResult = await loadSinglePlugin(pi, manifest.id);
    if (loadResult.ok) {
      ctx.ui.notify(`Plugin "${manifest.name}" v${manifest.version} installed and activated.`, "info");
    } else {
      ctx.ui.notify(`Plugin "${manifest.name}" v${manifest.version} installed but failed to activate: ${loadResult.message}`, "warning");
    }
  } catch (err) {
    ctx.ui.notify(`Failed to install plugin: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

function handleRemove(id: string, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd plugin remove <plugin-id>", "warning");
    return;
  }

  if (removePlugin(id)) {
    ctx.ui.notify(`Plugin "${id}" removed. Restart GSD for full effect.`, "info");
  } else {
    ctx.ui.notify(`Plugin "${id}" not found.`, "warning");
  }
}

function handleEnable(id: string, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd plugin enable <plugin-id>", "warning");
    return;
  }

  if (enablePlugin(id)) {
    ctx.ui.notify(`Plugin "${id}" enabled. Restart GSD to activate.`, "info");
  } else {
    ctx.ui.notify(`Plugin "${id}" not found.`, "warning");
  }
}

function handleDisable(id: string, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd plugin disable <plugin-id>", "warning");
    return;
  }

  if (disablePlugin(id)) {
    ctx.ui.notify(`Plugin "${id}" disabled. Restart GSD for full effect.`, "info");
  } else {
    ctx.ui.notify(`Plugin "${id}" not found.`, "warning");
  }
}

function handleInfo(id: string, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd plugin info <plugin-id>", "warning");
    return;
  }

  const record = getPluginById(id);
  if (!record) {
    ctx.ui.notify(`Plugin "${id}" not found in registry. Is it installed?`, "warning");
    return;
  }

  const m = record.manifest;
  const lines = [
    `**${m.name}** v${m.version}`,
    `ID: ${m.id}`,
    `Type: ${m.type}`,
    `State: ${record.state}`,
    `Description: ${m.description}`,
    `Entry: ${m.entry}`,
  ];

  if (m.provider) {
    lines.push(`Provider: ${m.provider.displayName} (${m.provider.authType})`);
    if (m.provider.defaultModel) lines.push(`Default model: ${m.provider.defaultModel}`);
  }

  if (m.dependencies?.runtime?.length) {
    lines.push(`Runtime deps: ${m.dependencies.runtime.join(", ")}`);
  }

  if (record.error) {
    lines.push(`Error: ${record.error}`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}
