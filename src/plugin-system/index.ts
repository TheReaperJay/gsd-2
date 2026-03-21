/**
 * GSD Plugin System — public API.
 */

export { loadPlugins } from "./plugin-loader.js";
export { handlePlugin } from "./plugin-cli.js";
export { discoverPlugins } from "./plugin-discovery.js";
export { getPlugins, getPluginById } from "./plugin-registry.js";
export { installPlugin, removePlugin, enablePlugin, disablePlugin, listPlugins } from "./plugin-installer.js";

export type {
  GsdPluginManifest,
  GsdPluginContext,
  GsdPluginFactory,
  GsdPluginModule,
  GsdPluginRecord,
  GsdPluginState,
  PluginLoadResult,
} from "./types.js";
