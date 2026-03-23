export type {
  GsdToolDef,
  GsdProviderDeps,
  GsdUsage,
  GsdEvent,
  GsdEventStream,
  GsdModel,
  GsdStreamContext,
  GsdProviderInfo,
  GsdProviderAuth,
  GsdProviderAuthCli,
  GsdProviderAuthApiKey,
  GsdProviderAuthOAuth,
  GsdProviderAuthNone,
} from "./types.js";

export {
  registerProviderInfo,
  getRegisteredProviderInfos,
  setProviderDeps,
  getProviderDeps,
  removeProviderInfo,
} from "./provider-registry.js";

export {
  registerGsdTool,
  getGsdTools,
} from "./tool-registry.js";

export { defineGsdTool } from "./define-tool.js";

export { wireProvidersToPI } from "./adapter.js";

export { discoverLocalProviders } from "./local-discovery.js";

export { runPluginOnboarding } from "./plugin-onboarding.js";
