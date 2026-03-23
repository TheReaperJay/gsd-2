/**
 * Default onboarding flow for plugin providers.
 *
 * If the provider declares a custom `onboard()` function, that is called and its
 * boolean result is wrapped in `{ ok }`. Otherwise, the default CLI auth flow runs:
 * spinner, check(), credential storage, and optional default model setting.
 *
 * Callable from both first-run onboarding (via runLlmStep) and post-install
 * extension onboarding (via handleInstall).
 */

import type { GsdProviderInfo } from "./types.js";
import type { AuthStorage, SettingsManager } from "@gsd/pi-coding-agent";

type ClackModule = typeof import("@clack/prompts");
type PicoModule = {
  cyan: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
  red: (s: string) => string;
  reset: (s: string) => string;
};

export async function runPluginOnboarding(
  pp: GsdProviderInfo,
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  settingsManager?: SettingsManager,
): Promise<{ ok: boolean }> {
  if (pp.onboard) {
    const result = await pp.onboard(p, pc, authStorage);
    return { ok: result };
  }

  if (pp.auth.type === "cli") {
    const s = p.spinner();
    s.start(`Checking ${pp.displayName}...`);
    const result = pp.auth.check();
    if (result.ok) {
      s.stop(`${pc.green(pp.displayName)} authenticated${result.email ? ` as ${result.email}` : ""}`);
      authStorage.set(pp.id, pp.auth.credential);
      if (pp.defaultModel && settingsManager) {
        settingsManager.setDefaultModelAndProvider(pp.id, pp.defaultModel);
      }
      return { ok: true };
    } else {
      s.stop(`${pp.displayName}: ${result.reason}`);
      p.log.warn(result.instruction);
      return { ok: false };
    }
  }

  return { ok: true };
}
