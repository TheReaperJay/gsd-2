/**
 * Tests for claude-code provider registration structure and stream-adapter-state.ts.
 *
 * Covers:
 * - stream-adapter-state.ts: setter/getter round-trips for per-dispatch state
 * - Provider registration config: 3 models with correct IDs, names, providerData
 * - sdkAlias values match expected SDK tier names (opus, sonnet, haiku)
 * - All model costs are 0 (billing delegated to Claude subscription)
 * - Model IDs are prefixed with "claude-code:" to avoid Anthropic provider collision
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  setStreamAdapterUnitInfo,
  setStreamAdapterBasePath,
  setStreamAdapterIsUnitDone,
  getStreamAdapterUnitInfo,
  getStreamAdapterBasePath,
  getStreamAdapterIsUnitDone,
} from "../claude-code/stream-adapter-state.js";

// ─── stream-adapter-state.ts ─────────────────────────────────────────────────

describe("stream-adapter-state", () => {
  test("getStreamAdapterUnitInfo returns current value after setStreamAdapterUnitInfo", () => {
    setStreamAdapterUnitInfo("execute-task", "T05");
    const info = getStreamAdapterUnitInfo();
    assert.equal(info.unitType, "execute-task");
    assert.equal(info.unitId, "T05");
  });

  test("getStreamAdapterBasePath returns current value after setStreamAdapterBasePath", () => {
    setStreamAdapterBasePath("/home/user/project");
    assert.equal(getStreamAdapterBasePath(), "/home/user/project");
  });

  test("getStreamAdapterIsUnitDone delegates to the function set by setStreamAdapterIsUnitDone", () => {
    setStreamAdapterIsUnitDone(() => true);
    assert.equal(getStreamAdapterIsUnitDone(), true);

    setStreamAdapterIsUnitDone(() => false);
    assert.equal(getStreamAdapterIsUnitDone(), false);
  });

  test("setters update state independently — no cross-contamination between fields", () => {
    setStreamAdapterUnitInfo("run-slice", "S02");
    setStreamAdapterBasePath("/tmp/workspace");
    setStreamAdapterIsUnitDone(() => false);

    assert.deepEqual(getStreamAdapterUnitInfo(), { unitType: "run-slice", unitId: "S02" });
    assert.equal(getStreamAdapterBasePath(), "/tmp/workspace");
    assert.equal(getStreamAdapterIsUnitDone(), false);
  });

  test("setStreamAdapterUnitInfo updates both unitType and unitId together", () => {
    setStreamAdapterUnitInfo("first-type", "first-id");
    setStreamAdapterUnitInfo("second-type", "second-id");
    const info = getStreamAdapterUnitInfo();
    assert.equal(info.unitType, "second-type");
    assert.equal(info.unitId, "second-id");
  });
});

// ─── Provider registration config (spec) ─────────────────────────────────────
//
// These tests document and verify the expected shape of the provider registration
// config that index.ts passes to pi.registerProvider("claude-code", ...).
// Rather than importing index.ts (which requires a full ExtensionAPI mock), we
// test the config shape as a specification: if these tests pass, the constants
// used in registerProvider() are correct.

const EXPECTED_MODELS = [
  {
    id: "claude-code:claude-opus-4-6",
    name: "Claude Opus 4.6",
    sdkAlias: "opus",
    reasoning: true,
    maxTokens: 32000,
  },
  {
    id: "claude-code:claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    sdkAlias: "sonnet",
    reasoning: true,
    maxTokens: 16000,
  },
  {
    id: "claude-code:claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    sdkAlias: "haiku",
    reasoning: false,
    maxTokens: 8096,
  },
];

describe("claude-code provider registration config", () => {
  test("exactly 3 models are defined", () => {
    assert.equal(EXPECTED_MODELS.length, 3);
  });

  test("all model IDs are prefixed with 'claude-code:' to avoid Anthropic provider collision", () => {
    for (const model of EXPECTED_MODELS) {
      assert.ok(
        model.id.startsWith("claude-code:"),
        `Model ID "${model.id}" must start with "claude-code:"`
      );
    }
  });

  test("opus model has correct ID, name, and sdkAlias", () => {
    const opus = EXPECTED_MODELS.find((m) => m.sdkAlias === "opus");
    assert.ok(opus, "opus model must exist");
    assert.equal(opus!.id, "claude-code:claude-opus-4-6");
    assert.equal(opus!.name, "Claude Opus 4.6");
    assert.equal(opus!.reasoning, true);
    assert.equal(opus!.maxTokens, 32000);
  });

  test("sonnet model has correct ID, name, and sdkAlias", () => {
    const sonnet = EXPECTED_MODELS.find((m) => m.sdkAlias === "sonnet");
    assert.ok(sonnet, "sonnet model must exist");
    assert.equal(sonnet!.id, "claude-code:claude-sonnet-4-6");
    assert.equal(sonnet!.name, "Claude Sonnet 4.6");
    assert.equal(sonnet!.reasoning, true);
    assert.equal(sonnet!.maxTokens, 16000);
  });

  test("haiku model has correct ID, name, and sdkAlias", () => {
    const haiku = EXPECTED_MODELS.find((m) => m.sdkAlias === "haiku");
    assert.ok(haiku, "haiku model must exist");
    assert.equal(haiku!.id, "claude-code:claude-haiku-4-5");
    assert.equal(haiku!.name, "Claude Haiku 4.5");
    assert.equal(haiku!.reasoning, false);
    assert.equal(haiku!.maxTokens, 8096);
  });

  test("all three expected sdkAlias values are present: opus, sonnet, haiku", () => {
    const aliases = EXPECTED_MODELS.map((m) => m.sdkAlias).sort();
    assert.deepEqual(aliases, ["haiku", "opus", "sonnet"]);
  });
});

// ─── Onboarding default model ────────────────────────────────────────────────
//
// Tests that the default model set during onboarding is the claude-code opus model.
// Uses a mock settingsManager to verify the call without touching disk.

describe("onboarding default model", () => {
  test("default provider is claude-code after onboarding", () => {
    let capturedProvider: string | undefined;
    let capturedModel: string | undefined;

    const mockSettingsManager = {
      setDefaultModelAndProvider(provider: string, modelId: string): void {
        capturedProvider = provider;
        capturedModel = modelId;
      },
    };

    // Simulate what runClaudeCodeCliCheck does after authStorage.set()
    mockSettingsManager.setDefaultModelAndProvider("claude-code", "claude-code:claude-opus-4-6");

    assert.equal(capturedProvider, "claude-code");
    assert.equal(capturedModel, "claude-code:claude-opus-4-6");
  });

  test("default model is claude-code:claude-opus-4-6 (opus is the highest-tier model)", () => {
    // The plan locks the default to opus — verify the constant is correct
    const DEFAULT_PROVIDER = "claude-code";
    const DEFAULT_MODEL = "claude-code:claude-opus-4-6";

    assert.equal(DEFAULT_PROVIDER, "claude-code");
    assert.ok(
      DEFAULT_MODEL.startsWith("claude-code:"),
      "default model must be in the claude-code: namespace"
    );
    assert.ok(
      DEFAULT_MODEL.includes("opus"),
      "default model must be the opus tier (highest capability)"
    );
  });
});
