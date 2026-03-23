/**
 * Extensions Install — Structural Contract Tests
 *
 * Verifies that handleInstall() implements the required onboarding flow:
 * - ONBOARD-01: Hot-load via jiti extension factory (not direct wireProvidersToPI)
 * - ONBOARD-02: Runtime dependency check before hot-load (spawnSync --version)
 * - ONBOARD-03: Provider onboarding dispatch after hot-load
 * - D-04: pp.onboard() is type-agnostic — checked before manifest.provides.provider
 * - D-05: runPluginOnboarding fallback for provider extensions without custom onboard()
 *
 * Uses static source analysis to verify structural contracts. handleInstall()
 * depends on filesystem, npm, jiti, Pi, and external CLIs — unit-testing the
 * actual execution would require mocking the entire universe. Static analysis
 * verifies the CONTRACT: right functions called in right order.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read the source file for static analysis
const srcPath = join(import.meta.dirname, "..", "commands-extensions.ts");
const src = readFileSync(srcPath, "utf-8");

// Extract handleInstall function body
// Match from the async function declaration to the closing brace at the same indentation level
const handleInstallStart = src.indexOf("async function handleInstall(");
assert.ok(handleInstallStart > -1, "handleInstall function must exist in commands-extensions.ts");

// Find the function body by locating the end — we grab a generous chunk after the signature
// The function ends at the last closing brace before handleRemove
const handleRemoveStart = src.indexOf("function handleRemove(");
const handleInstallBody = src.slice(handleInstallStart, handleRemoveStart);

describe("extensions install — runtime dependency check (ONBOARD-02)", () => {
  it("checks runtime deps with spawnSync before hot-loading", () => {
    assert.ok(
      handleInstallBody.includes('spawnSync(dep, ["--version"]'),
      "handleInstall must use spawnSync(dep, ['--version']) to check runtime dependencies",
    );
  });

  it("reports found dependencies to the user", () => {
    // D-12: found deps are explicitly reported before proceeding
    assert.ok(
      handleInstallBody.includes("Dependency found"),
      "handleInstall must report found dependencies to the user",
    );
  });

  it("blocks activation when dependencies are missing", () => {
    // D-14: missing deps block activation — return before hot-load
    // Verify the missing deps check comes before the hot-load section
    const missingCheckIndex = handleInstallBody.indexOf("missing.length > 0");
    const hotLoadIndex = handleInstallBody.indexOf("createJiti");
    assert.ok(missingCheckIndex > -1, "handleInstall must check for missing dependencies");
    assert.ok(hotLoadIndex > -1, "handleInstall must have hot-load section");
    assert.ok(
      missingCheckIndex < hotLoadIndex,
      "Runtime dep check must come before hot-load — missing deps block activation",
    );
  });

  it("returns early on missing deps (does not proceed to hot-load)", () => {
    // After missing deps detected, there must be a return before hot-load
    const depCheckSection = handleInstallBody.slice(
      handleInstallBody.indexOf("missing.length > 0"),
      handleInstallBody.indexOf("createJiti"),
    );
    assert.ok(
      depCheckSection.includes("return"),
      "handleInstall must return early when runtime deps are missing",
    );
  });
});

describe("extensions install — hot-load (ONBOARD-01)", () => {
  it("uses jiti to import extension factory", () => {
    assert.ok(
      handleInstallBody.includes("createJiti"),
      "handleInstall must use createJiti for hot-loading",
    );
    assert.ok(
      handleInstallBody.includes("jiti.import"),
      "handleInstall must use jiti.import to load extension entry",
    );
  });

  it("invokes extension factory with pi — not wireProvidersToPI directly", () => {
    assert.ok(
      handleInstallBody.includes("mod.default(pi)"),
      "handleInstall must call mod.default(pi) — the extension factory",
    );
    // CRITICAL: handleInstall must NOT call wireProvidersToPI (causes listener stacking)
    assert.ok(
      !handleInstallBody.includes("wireProvidersToPI(pi)"),
      "handleInstall must NOT call wireProvidersToPI directly — the factory handles it",
    );
  });

  it("looks for index.ts first, then index.js", () => {
    const tsIndex = handleInstallBody.indexOf('"index.ts"');
    const jsIndex = handleInstallBody.indexOf('"index.js"');
    assert.ok(tsIndex > -1, "handleInstall must look for index.ts");
    assert.ok(jsIndex > -1, "handleInstall must look for index.js as fallback");
    assert.ok(tsIndex < jsIndex, "index.ts must be checked before index.js");
  });

  it("snapshots provider registry before hot-load to detect new providers", () => {
    // beforeIds must be captured BEFORE the jiti.import / mod.default call
    const beforeIdsIndex = handleInstallBody.indexOf("beforeIds");
    const jitiImportIndex = handleInstallBody.indexOf("jiti.import");
    assert.ok(beforeIdsIndex > -1, "handleInstall must snapshot beforeIds from provider registry");
    assert.ok(
      beforeIdsIndex < jitiImportIndex,
      "beforeIds snapshot must come before jiti.import (hot-load)",
    );
    // newProviders diff must come after hot-load
    const newProvidersIndex = handleInstallBody.indexOf("newProviders");
    assert.ok(newProvidersIndex > -1, "handleInstall must compute newProviders after hot-load");
    assert.ok(
      newProvidersIndex > jitiImportIndex,
      "newProviders diff must come after hot-load",
    );
  });
});

describe("extensions install — onboarding dispatch (ONBOARD-03, D-04)", () => {
  it("checks pp.onboard before manifest.provides?.provider — type-agnostic dispatch (D-04)", () => {
    // D-04: onboard() dispatch is NOT gated on manifest.provides.provider
    // The pp.onboard check must come BEFORE the manifest.provides?.provider check
    const onboardCheckIndex = handleInstallBody.indexOf("pp.onboard");
    const manifestProviderIndex = handleInstallBody.indexOf("manifest.provides?.provider");
    assert.ok(onboardCheckIndex > -1, "handleInstall must check pp.onboard");
    assert.ok(manifestProviderIndex > -1, "handleInstall must check manifest.provides?.provider");
    assert.ok(
      onboardCheckIndex < manifestProviderIndex,
      "pp.onboard check must come before manifest.provides?.provider — onboard() is type-agnostic per D-04",
    );
  });

  it("calls runPluginOnboarding for provider extensions without custom onboard (D-05)", () => {
    assert.ok(
      handleInstallBody.includes("runPluginOnboarding"),
      "handleInstall must call runPluginOnboarding for provider extensions without custom onboard",
    );
  });

  it("shows success summary for authenticated provider", () => {
    assert.ok(
      handleInstallBody.includes("installed and activated"),
      "handleInstall must show 'installed and activated' for successful provider auth",
    );
    assert.ok(
      handleInstallBody.includes("Models:"),
      "handleInstall must show available models in summary",
    );
  });

  it("shows warning for unauthenticated provider — does not block install", () => {
    assert.ok(
      handleInstallBody.includes("not authenticated"),
      "handleInstall must show auth failure status for unauthenticated providers",
    );
  });

  it("non-provider extensions with no new providers get simple success message", () => {
    // The else branch for no new providers must show a simple activation message
    assert.ok(
      handleInstallBody.includes("installed and activated"),
      "handleInstall must have success message for non-provider extensions",
    );
  });

  it("dynamic imports of authStorage/settingsManager are documented with explanatory comment", () => {
    // The deviation from self-contained pattern must be documented
    assert.ok(
      handleInstallBody.includes("deliberate deviation"),
      "handleInstall must document why dynamic imports are used for authStorage/settingsManager",
    );
  });
});
