/**
 * dispatch-provider.test.ts — Integration test for claude-code provider dispatch
 *
 * Verifies the dispatch path for claude-code models end-to-end:
 * - streamSimple factory returns AssistantMessageEventStream for claude-code model
 * - Model construction with provider: "claude-code" and providerData is valid
 * - No references to deleted modules remain in production code
 * - auto.ts writeLock uses session file directly (no provider conditional)
 *
 * These are structural regression tests: they fail if the integration is broken
 * or deleted modules are re-introduced.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createClaudeCodeStream } from "../claude-code/stream-adapter.js";
import type { StreamAdapterDeps } from "../claude-code/stream-adapter.js";
import type { Model, Api, Context } from "@gsd/pi-ai";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockDeps(overrides?: Partial<StreamAdapterDeps>): StreamAdapterDeps {
  return {
    getSupervisorConfig: () => ({}),
    shouldBlockContextWrite: () => ({ block: false }),
    getMilestoneId: () => null,
    isDepthVerified: () => true,
    getIsUnitDone: () => false,
    onToolStart: () => {},
    onToolEnd: () => {},
    getBasePath: () => "/test/project",
    getUnitInfo: () => ({ unitType: "execute-task", unitId: "test-unit" }),
    ...overrides,
  };
}

function makeClaudeCodeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "claude-code:claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages" as Api,
    provider: "claude-code",
    baseUrl: "claude-code:",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16000,
    providerData: {
      "claude-code": { sdkAlias: "sonnet" },
    },
    ...overrides,
  };
}

function makeContext(overrides?: Partial<Context>): Context {
  return {
    systemPrompt: "You are a GSD agent.",
    messages: [],
    ...overrides,
  };
}

// Absolute path to the GSD extension source directory — used for fs-based assertions
const GSD_SRC = join(
  new URL("../", import.meta.url).pathname,
);

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("claude-code provider dispatch", () => {

  it("streamSimple returns AssistantMessageEventStream for claude-code model", () => {
    const deps = createMockDeps();
    const streamFn = createClaudeCodeStream(deps);

    const model = makeClaudeCodeModel();
    const context = makeContext();

    // streamSimple must return synchronously (same as streamAnthropic)
    const stream = streamFn(model, context);

    assert.ok(stream !== null && stream !== undefined, "stream must not be null or undefined");
    assert.ok(
      typeof (stream as unknown as Record<string, unknown>)[Symbol.asyncIterator] === "function",
      "returned stream must implement AsyncIterable (AssistantMessageEventStream)",
    );
  });

  it("model with provider: 'claude-code' and providerData carries sdkAlias", () => {
    const model = makeClaudeCodeModel({
      providerData: {
        "claude-code": { sdkAlias: "sonnet" },
      },
    });

    assert.equal(model.provider, "claude-code");
    assert.equal(model.providerData?.["claude-code"]?.sdkAlias, "sonnet");
  });

  it("no references to deleted modules in production code", () => {
    // Read auto.ts and verify the deleted modules (sdk-executor, hook-bridge,
    // models-resolver-within-claude-code, provider-routing) are not imported.
    const autoTs = readFileSync(join(GSD_SRC, "auto.ts"), "utf8");

    const DELETED_MODULES = ["sdk-executor", "hook-bridge", "provider-routing"];
    for (const mod of DELETED_MODULES) {
      assert.ok(
        !autoTs.includes(mod),
        `auto.ts must not reference deleted module: ${mod}`,
      );
    }

    // Also verify index.ts has no references to deleted modules
    const indexTs = readFileSync(join(GSD_SRC, "index.ts"), "utf8");
    for (const mod of DELETED_MODULES) {
      assert.ok(
        !indexTs.includes(mod),
        `index.ts must not reference deleted module: ${mod}`,
      );
    }
  });

  it("auto.ts writeLock uses session file directly (no provider conditional)", () => {
    const autoTs = readFileSync(join(GSD_SRC, "auto.ts"), "utf8");

    // writeLock calls must use ctx.sessionManager.getSessionFile() directly
    assert.ok(
      autoTs.includes("ctx.sessionManager.getSessionFile()"),
      "auto.ts must call ctx.sessionManager.getSessionFile() for writeLock session file",
    );

    // No provider-conditional lock variables allowed
    assert.ok(
      !autoTs.includes("providerForLock"),
      "auto.ts must not contain 'providerForLock' (bolt-on provider conditional removed)",
    );
    assert.ok(
      !autoTs.includes("sessionFileForLock"),
      "auto.ts must not contain 'sessionFileForLock' (bolt-on provider conditional removed)",
    );
  });

  it("index.ts registers claude-code provider via pi.registerProvider()", () => {
    const indexTs = readFileSync(join(GSD_SRC, "index.ts"), "utf8");

    assert.ok(
      indexTs.includes('pi.registerProvider("claude-code"'),
      "index.ts must call pi.registerProvider(\"claude-code\", ...) to register the provider",
    );
  });

  it("createClaudeCodeStream dep getters are not called at factory creation time", () => {
    const calls: string[] = [];

    const deps = createMockDeps({
      getUnitInfo: () => {
        calls.push("getUnitInfo");
        return { unitType: "execute-task", unitId: "M001/S01/T01" };
      },
      getBasePath: () => {
        calls.push("getBasePath");
        return "/test/project";
      },
      getIsUnitDone: () => {
        calls.push("getIsUnitDone");
        return false;
      },
      getSupervisorConfig: () => {
        calls.push("getSupervisorConfig");
        return {};
      },
    });

    // Factory creation must NOT invoke any per-invocation getters
    createClaudeCodeStream(deps);

    assert.deepEqual(calls, [], "dep getters must NOT be called at factory creation time");
  });

});
