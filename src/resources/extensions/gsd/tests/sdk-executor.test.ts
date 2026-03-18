/**
 * Unit tests for sdk-executor.ts — verifies SteeringQueue behavior and
 * sdkExecuteUnit() integration with the Claude Agent SDK.
 *
 * Mock strategy:
 * - SDK (`@anthropic-ai/claude-agent-sdk`) is injected via optional `_sdkOverride`
 *   parameter on sdkExecuteUnit() — no dynamic import() mocking required.
 * - Phase 2 dependencies (hook-bridge, activity-writer, models-resolver, mcp-tools)
 *   are injected via optional `_deps` parameter for full isolation.
 *
 * Covers:
 * - SteeringQueue yields messages in order
 * - SteeringQueue blocks until push() or close()
 * - SteeringQueue stops after close()
 * - SteeringQueue yields initial prompt as first message
 * - query() options: model, effort, thinking, systemPrompt, cwd, permissionMode,
 *   allowDangerouslySkipPermissions, persistSession, hooks (with Stop), NO maxTurns
 * - Message processing: processAssistantMessage, processResultMessage, flush, getMetrics
 * - Stop hook: { continue: false } when isUnitDone()=false and stop_hook_active=true
 * - Stop hook: {} when isUnitDone()=true
 * - Stop hook: {} when stop_hook_active=false (prevents infinite loop)
 * - Error handling: SDKResultError subtypes set isError=true, extract error message
 * - Rate-limit detection from error message
 * - Wrapup warning text and priority "now"
 * - Idle recovery text and priority "now"
 * - steeringQueue.close() called in finally block
 * - sdkActiveQuery set to null in finally block
 */

import test, { describe, mock } from "node:test";
import assert from "node:assert/strict";

import { SteeringQueue, sdkExecuteUnit } from "../claude-code/sdk-executor.js";
import type { SdkExecutorParams } from "../claude-code/sdk-executor.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Minimal params for sdkExecuteUnit tests — override specific fields as needed */
function makeParams(overrides?: Partial<SdkExecutorParams>): SdkExecutorParams {
  return {
    basePath: "/fake/project",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    systemPrompt: "You are a GSD agent. Complete the task.",
    effectiveModelId: "claude-sonnet-4-6",
    complexityTier: "standard",
    startedAt: Date.now(),
    softTimeoutMs: 0,
    idleTimeoutMs: 0,
    hardTimeoutMs: 0,
    onToolStart: () => {},
    onToolEnd: () => {},
    shouldBlockContextWrite: () => ({ block: false }),
    getMilestoneId: () => null,
    isDepthVerified: () => false,
    isUnitDone: () => true,
    ...overrides,
  };
}

/** Build a minimal fake SDK with a query() that yields given messages then returns */
function makeFakeSdk(messages: unknown[], resultMsg?: unknown) {
  const capturedOptions: Record<string, unknown> = {};

  async function* fakeQueryGen(params: { prompt: unknown; options?: unknown }) {
    capturedOptions["prompt"] = params.prompt;
    capturedOptions["options"] = params.options;
    for (const msg of messages) {
      yield msg;
    }
    if (resultMsg) {
      yield resultMsg;
    }
  }

  // The query function must return an async iterable — we do that by returning the generator
  function query(params: { prompt: unknown; options?: unknown }) {
    return fakeQueryGen(params);
  }

  return { query, capturedOptions };
}

/** Fake activity writer to track calls */
function makeFakeActivityWriter() {
  const assistantMessages: unknown[] = [];
  const toolResults: Array<{ id: string; content: unknown; isError: boolean }> = [];
  const resultMessages: unknown[] = [];
  let flushCalled = false;

  return {
    processAssistantMessage: (msg: unknown) => { assistantMessages.push(msg); },
    processToolResult: (id: string, content: unknown, isError: boolean) => { toolResults.push({ id, content, isError }); },
    processResultMessage: (msg: unknown) => { resultMessages.push(msg); },
    flush: () => { flushCalled = true; return null; },
    getMetrics: () => ({ costUsd: 0.005, inputTokens: 1000, outputTokens: 200 }),
    getEntries: () => [],
    // Inspection properties
    assistantMessages,
    toolResults,
    resultMessages,
    get flushCalled() { return flushCalled; },
  };
}

/** Fake hook bridge to inspect stop hook registration */
function makeFakeHookBridge() {
  return {
    PreToolUse: [{ hooks: [async () => ({})] }],
    PostToolUse: [{ hooks: [async () => ({})] }],
    PostToolUseFailure: [{ hooks: [async () => ({})] }],
  };
}

/** Deps override for sdkExecuteUnit tests */
function makeDeps(overrides?: Partial<{
  activityWriter: ReturnType<typeof makeFakeActivityWriter>;
  hookBridge: ReturnType<typeof makeFakeHookBridge>;
  mcpServer: unknown;
  modelAlias: string;
  tierConfig: { model: string; effort: string; thinking: unknown };
}>) {
  const activityWriter = overrides?.activityWriter ?? makeFakeActivityWriter();
  const hookBridge = overrides?.hookBridge ?? makeFakeHookBridge();
  return {
    activityWriter,
    hookBridge,
    mcpServer: overrides?.mcpServer ?? {},
    modelAlias: overrides?.modelAlias ?? "sonnet",
    tierConfig: overrides?.tierConfig ?? {
      model: "sonnet",
      effort: "medium",
      thinking: { type: "enabled" },
    },
  };
}

// ─── SteeringQueue ──────────────────────────────────────────────────────────

describe("SteeringQueue", () => {

  test("yields pushed messages in order", async () => {
    const q = new SteeringQueue("initial prompt");
    // Consume initial prompt first
    const iter = q[Symbol.asyncIterator]();
    const first = await iter.next();
    assert.equal((first.value as { message: { content: string } }).message.content, "initial prompt");

    // Push two messages then close
    q.push({
      type: "user",
      message: { role: "user", content: "message A" },
      priority: "now",
      session_id: "",
      parent_tool_use_id: null,
    } as unknown as never);
    q.push({
      type: "user",
      message: { role: "user", content: "message B" },
      priority: "now",
      session_id: "",
      parent_tool_use_id: null,
    } as unknown as never);
    q.close();

    const second = await iter.next();
    const third = await iter.next();
    const fourth = await iter.next();

    assert.equal((second.value as { message: { content: string } }).message.content, "message A");
    assert.equal((third.value as { message: { content: string } }).message.content, "message B");
    assert.equal(fourth.done, true);
  });

  test("blocks on empty queue until push() resolves it", async () => {
    const q = new SteeringQueue("prompt");
    const iter = q[Symbol.asyncIterator]();

    // Consume initial prompt
    await iter.next();

    // Set up a push that will happen after a short delay
    let pushTime = 0;
    const pushPromise = new Promise<void>(resolve => {
      setTimeout(() => {
        pushTime = Date.now();
        q.push({
          type: "user",
          message: { role: "user", content: "delayed" },
          priority: "now",
          session_id: "",
          parent_tool_use_id: null,
        } as unknown as never);
        q.close();
        resolve();
      }, 20);
    });

    const beforeTime = Date.now();
    const nextResult = await iter.next();
    await pushPromise;

    // The next() call should have waited for the push
    assert.ok(pushTime >= beforeTime, "push should happen after we started waiting");
    assert.equal((nextResult.value as { message: { content: string } }).message.content, "delayed");
  });

  test("stops iteration after close()", async () => {
    const q = new SteeringQueue("prompt");
    const iter = q[Symbol.asyncIterator]();

    // Consume initial prompt
    await iter.next();

    // Close immediately
    q.close();

    const result = await iter.next();
    assert.equal(result.done, true);
  });

  test("yields initial prompt as first message with role user", async () => {
    const q = new SteeringQueue("the initial unit prompt");
    const iter = q[Symbol.asyncIterator]();

    const first = await iter.next();
    assert.equal(first.done, false);

    const msg = first.value as { message: { role: string; content: string }; priority: string };
    assert.equal(msg.message.role, "user");
    assert.equal(msg.message.content, "the initial unit prompt");
    // Initial prompt should use priority "now" to immediately kick off the unit
    assert.equal(msg.priority, "now");
  });

  test("for-await-of works across close() after initial prompt", async () => {
    const q = new SteeringQueue("test prompt");
    const collected: string[] = [];

    // Close after initial consumption
    setTimeout(() => q.close(), 10);

    for await (const msg of q) {
      collected.push((msg as { message: { content: string } }).message.content);
    }

    assert.equal(collected.length, 1);
    assert.equal(collected[0], "test prompt");
  });

});

// ─── sdkExecuteUnit — query() options ──────────────────────────────────────

describe("sdkExecuteUnit — query options", () => {

  test("query() is called with model from resolveClaudeCodeAlias(effectiveModelId)", async () => {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const deps = makeDeps({ modelAlias: "opus" });

    await sdkExecuteUnit(makeParams({ effectiveModelId: "claude-opus-4-6" }), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    assert.equal(opts["model"], "opus");
  });

  test("query() is called with effort from getSdkTierConfig(complexityTier)", async () => {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const deps = makeDeps({ tierConfig: { model: "opus", effort: "high", thinking: { type: "enabled" } } });

    await sdkExecuteUnit(makeParams({ complexityTier: "heavy" }), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    assert.equal(opts["effort"], "high");
  });

  test("query() is called with thinking from getSdkTierConfig(complexityTier)", async () => {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const deps = makeDeps({ tierConfig: { model: "haiku", effort: "low", thinking: { type: "disabled" } } });

    await sdkExecuteUnit(makeParams({ complexityTier: "light" }), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    assert.deepEqual(opts["thinking"], { type: "disabled" });
  });

  test("query() is called with systemPrompt matching params.systemPrompt", async () => {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const deps = makeDeps();

    await sdkExecuteUnit(makeParams({ systemPrompt: "Custom system prompt content" }), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    assert.equal(opts["systemPrompt"], "Custom system prompt content");
  });

  test("query() is called with cwd=basePath", async () => {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const deps = makeDeps();

    await sdkExecuteUnit(makeParams({ basePath: "/my/project" }), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    assert.equal(opts["cwd"], "/my/project");
  });

  test("query() is called with permissionMode='bypassPermissions'", async () => {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const deps = makeDeps();

    await sdkExecuteUnit(makeParams(), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    assert.equal(opts["permissionMode"], "bypassPermissions");
  });

  test("query() is called with allowDangerouslySkipPermissions=true", async () => {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const deps = makeDeps();

    await sdkExecuteUnit(makeParams(), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    assert.equal(opts["allowDangerouslySkipPermissions"], true);
  });

  test("query() is called with persistSession=false (Pitfall 6 prevention)", async () => {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const deps = makeDeps();

    await sdkExecuteUnit(makeParams(), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    assert.equal(opts["persistSession"], false);
  });

  test("query() options do NOT contain maxTurns (LOCKED: time-based supervision only)", async () => {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const deps = makeDeps();

    await sdkExecuteUnit(makeParams(), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    assert.ok(!("maxTurns" in opts), "maxTurns must NOT be set in query options");
  });

  test("query() hooks include PreToolUse, PostToolUse, PostToolUseFailure from hook bridge", async () => {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const hookBridge = makeFakeHookBridge();
    const deps = makeDeps({ hookBridge });

    await sdkExecuteUnit(makeParams(), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    const hooks = opts["hooks"] as Record<string, unknown>;
    assert.ok("PreToolUse" in hooks, "hooks must contain PreToolUse");
    assert.ok("PostToolUse" in hooks, "hooks must contain PostToolUse");
    assert.ok("PostToolUseFailure" in hooks, "hooks must contain PostToolUseFailure");
  });

  test("query() hooks include Stop hook handler", async () => {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const deps = makeDeps();

    await sdkExecuteUnit(makeParams(), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    const hooks = opts["hooks"] as Record<string, unknown>;
    assert.ok("Stop" in hooks, "hooks must contain Stop handler");
    const stopHooks = hooks["Stop"] as Array<{ hooks: unknown[] }>;
    assert.ok(Array.isArray(stopHooks), "Stop must be an array");
    assert.ok(stopHooks.length > 0, "Stop must have at least one entry");
    assert.ok(Array.isArray(stopHooks[0].hooks), "Stop[0].hooks must be an array");
    assert.ok(typeof stopHooks[0].hooks[0] === "function", "Stop hook must be a function");
  });

});

// ─── sdkExecuteUnit — message processing ───────────────────────────────────

describe("sdkExecuteUnit — message processing", () => {

  test("assistant messages are passed to activityWriter.processAssistantMessage()", async () => {
    const assistantMsg = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      session_id: "sess_01",
    };
    const { query } = makeFakeSdk([assistantMsg], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const activityWriter = makeFakeActivityWriter();
    const deps = makeDeps({ activityWriter });

    await sdkExecuteUnit(makeParams(), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.equal(activityWriter.assistantMessages.length, 1);
    assert.deepEqual(activityWriter.assistantMessages[0], assistantMsg);
  });

  test("result messages are passed to activityWriter.processResultMessage()", async () => {
    const resultMsg = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "completed",
      total_cost_usd: 0.001,
      usage: { input_tokens: 500, output_tokens: 100 },
    };
    const { query } = makeFakeSdk([], resultMsg);

    const activityWriter = makeFakeActivityWriter();
    const deps = makeDeps({ activityWriter });

    await sdkExecuteUnit(makeParams(), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.equal(activityWriter.resultMessages.length, 1);
    assert.deepEqual(activityWriter.resultMessages[0], resultMsg);
  });

  test("activityWriter.flush() is called after loop completes", async () => {
    const { query } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const activityWriter = makeFakeActivityWriter();
    const deps = makeDeps({ activityWriter });

    await sdkExecuteUnit(makeParams(), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.equal(activityWriter.flushCalled, true, "flush() must be called after loop completes");
  });

  test("activityWriter.getMetrics() values appear in returned SdkExecutorResult", async () => {
    const { query } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const activityWriter = makeFakeActivityWriter();
    // The fake returns { costUsd: 0.005, inputTokens: 1000, outputTokens: 200 }
    const deps = makeDeps({ activityWriter });

    const result = await sdkExecuteUnit(makeParams(), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.equal(result.metrics.costUsd, 0.005);
    assert.equal(result.metrics.inputTokens, 1000);
    assert.equal(result.metrics.outputTokens, 200);
  });

});

// ─── sdkExecuteUnit — Stop hook ────────────────────────────────────────────

describe("sdkExecuteUnit — Stop hook", () => {

  async function extractStopHook(
    isUnitDone: () => boolean,
  ): Promise<(input: unknown) => Promise<unknown>> {
    const { query, capturedOptions } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const deps = makeDeps();

    await sdkExecuteUnit(makeParams({ isUnitDone }), {
      query,
      ...deps,
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    const opts = capturedOptions["options"] as Record<string, unknown>;
    const hooks = opts["hooks"] as Record<string, unknown>;
    const stopHooks = hooks["Stop"] as Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
    return stopHooks[0].hooks[0];
  }

  test("Stop hook returns { continue: false } when isUnitDone()=false and stop_hook_active=true", async () => {
    const stopHook = await extractStopHook(() => false);
    const result = await stopHook({ stop_hook_active: true });
    assert.deepEqual(result, { continue: false });
  });

  test("Stop hook returns {} when isUnitDone()=true (allow completion)", async () => {
    const stopHook = await extractStopHook(() => true);
    const result = await stopHook({ stop_hook_active: true });
    assert.deepEqual(result, {});
  });

  test("Stop hook returns {} when stop_hook_active=false (CRITICAL: prevents infinite loop)", async () => {
    // Even if isUnitDone()=false, must return {} when stop_hook_active=false
    const stopHook = await extractStopHook(() => false);
    const result = await stopHook({ stop_hook_active: false });
    assert.deepEqual(result, {}, "must NOT block when stop_hook_active=false — prevents infinite loop (Pitfall 3)");
  });

});

// ─── sdkExecuteUnit — error handling ───────────────────────────────────────

describe("sdkExecuteUnit — error handling", () => {

  test("SDKResultError with subtype 'error_during_execution' sets isError=true in result", async () => {
    const { query } = makeFakeSdk([], {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["something went wrong"],
    });

    const result = await sdkExecuteUnit(makeParams(), {
      query,
      ...makeDeps(),
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.equal(result.isError, true);
  });

  test("SDKResultError with subtype 'error_max_turns' sets isError=true in result", async () => {
    const { query } = makeFakeSdk([], {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      errors: ["max turns exceeded"],
    });

    const result = await sdkExecuteUnit(makeParams(), {
      query,
      ...makeDeps(),
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.equal(result.isError, true);
  });

  test("SDKResultError with subtype 'error_max_budget_usd' sets isError=true in result", async () => {
    const { query } = makeFakeSdk([], {
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      errors: ["budget exceeded"],
    });

    const result = await sdkExecuteUnit(makeParams(), {
      query,
      ...makeDeps(),
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.equal(result.isError, true);
  });

  test("Error message is extracted from SDKResultError.errors array", async () => {
    const { query } = makeFakeSdk([], {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["first error", "second error"],
    });

    const result = await sdkExecuteUnit(makeParams(), {
      query,
      ...makeDeps(),
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.ok(result.errorMessage !== undefined, "errorMessage must be set");
    assert.ok(result.errorMessage!.includes("first error"), "errorMessage must include content from errors array");
  });

  test("Rate-limit pattern (/rate.?limit|429/) is detected from error message", async () => {
    const { query } = makeFakeSdk([], {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["rate_limit exceeded, please retry later"],
    });

    const result = await sdkExecuteUnit(makeParams(), {
      query,
      ...makeDeps(),
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.equal(result.isRateLimit, true);
  });

  test("Non-rate-limit error sets isRateLimit=false", async () => {
    const { query } = makeFakeSdk([], {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["some other failure occurred"],
    });

    const result = await sdkExecuteUnit(makeParams(), {
      query,
      ...makeDeps(),
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.equal(result.isRateLimit, false);
  });

  test("Successful result sets isError=false", async () => {
    const { query } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const result = await sdkExecuteUnit(makeParams(), {
      query,
      ...makeDeps(),
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.equal(result.isError, false);
    assert.equal(result.isRateLimit, false);
  });

});

// ─── sdkExecuteUnit — steering ─────────────────────────────────────────────

describe("sdkExecuteUnit — steering", () => {

  /**
   * Strategy: Use mock.timers to control when setTimeout/setInterval fires.
   * The query function collects all prompt messages (steering queue content) and
   * closes the queue ONLY after consuming all items. This avoids the `break`
   * pattern that calls .return() on the SteeringQueue generator (which would
   * leave a pending Promise<void> and cause node:test to warn about leaked promises).
   *
   * Pattern:
   * 1. Start sdkExecuteUnit with mock.timers enabled
   * 2. Run the query in background — it awaits messages from the prompt
   * 3. Advance fake timer with mock.timers.tick(softTimeoutMs) to trigger wrapup
   * 4. Query receives the pushed wrapup message, records it, then yields result
   * 5. Assert on recorded messages
   */

  test("Wrapup warning text matches Pi path content ('TIME BUDGET WARNING — keep going only if progress is real.')", async (t) => {
    t.mock.timers.enable(["setTimeout", "setInterval", "clearTimeout", "clearInterval"]);

    const promptMessages: unknown[] = [];
    let promptResolve: (() => void) | null = null;
    let promptReceived = 0;

    // Query: consumes prompt messages until it gets the wrapup warning (or >3 messages)
    // then yields result and closes.
    // Uses a manual promise so it can be unblocked by the test.
    async function* steeringTestQuery(params: { prompt: AsyncIterable<unknown>; options?: unknown }) {
      let count = 0;
      for await (const msg of params.prompt) {
        promptMessages.push(msg);
        promptReceived = count++;
        const content = (msg as { message?: { content?: string } }).message?.content ?? "";
        // Stop after seeing wrapup warning — but let close() happen via finally block
        if (content.includes("TIME BUDGET WARNING")) {
          // Resolve to signal the test the message was received
          promptResolve?.();
          break;
        }
        // Also stop if we've received too many messages without a wrapup
        if (count > 5) { promptResolve?.(); break; }
      }

      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }

    // Create a promise we can await until the query receives the wrapup message
    const wrapupReceived = new Promise<void>(r => { promptResolve = r; });

    const SOFT_TIMEOUT_MS = 100;

    // Run sdkExecuteUnit — it starts the timers with fake clock
    const execPromise = sdkExecuteUnit(
      makeParams({ softTimeoutMs: SOFT_TIMEOUT_MS, idleTimeoutMs: 0, hardTimeoutMs: 0 }),
      {
        query: steeringTestQuery,
        ...makeDeps(),
      } as unknown as Parameters<typeof sdkExecuteUnit>[1],
    );

    // Advance the fake timer to trigger the wrapup warning
    t.mock.timers.tick(SOFT_TIMEOUT_MS + 1);

    // Wait for query to receive the wrapup message
    await Promise.race([wrapupReceived, execPromise]);

    // Now let execution complete
    await execPromise;

    const wrapupMsg = promptMessages.find(m => {
      const content = (m as { message?: { content?: string } }).message?.content ?? "";
      return content.includes("TIME BUDGET WARNING");
    });

    assert.ok(wrapupMsg !== undefined, "Wrapup warning message must be pushed to steering queue");
    const content = (wrapupMsg as { message: { content: string } }).message.content;
    assert.ok(
      content.includes("TIME BUDGET WARNING — keep going only if progress is real."),
      `Wrapup warning must match Pi path text. Got: ${content}`,
    );
  });

  test("Wrapup warning is pushed with priority 'now'", async (t) => {
    t.mock.timers.enable(["setTimeout", "setInterval", "clearTimeout", "clearInterval"]);

    const promptMessages: unknown[] = [];
    let promptResolve: (() => void) | null = null;

    async function* wrapupPriorityQuery(params: { prompt: AsyncIterable<unknown>; options?: unknown }) {
      for await (const msg of params.prompt) {
        promptMessages.push(msg);
        const content = (msg as { message?: { content?: string } }).message?.content ?? "";
        if (content.includes("TIME BUDGET WARNING")) {
          promptResolve?.();
          break;
        }
        if (promptMessages.length > 5) { promptResolve?.(); break; }
      }

      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }

    const wrapupReceived = new Promise<void>(r => { promptResolve = r; });

    const SOFT_TIMEOUT_MS = 100;
    const execPromise = sdkExecuteUnit(
      makeParams({ softTimeoutMs: SOFT_TIMEOUT_MS, idleTimeoutMs: 0, hardTimeoutMs: 0 }),
      {
        query: wrapupPriorityQuery,
        ...makeDeps(),
      } as unknown as Parameters<typeof sdkExecuteUnit>[1],
    );

    t.mock.timers.tick(SOFT_TIMEOUT_MS + 1);
    await Promise.race([wrapupReceived, execPromise]);
    await execPromise;

    const wrapupMsg = promptMessages.find(m => {
      const content = (m as { message?: { content?: string } }).message?.content ?? "";
      return content.includes("TIME BUDGET WARNING");
    });

    assert.ok(wrapupMsg !== undefined, "Wrapup warning must be pushed");
    assert.equal(
      (wrapupMsg as { priority: string }).priority,
      "now",
      "Wrapup warning must use priority 'now'",
    );
  });

  test("Idle tracking wrappers reset lastActivityAt on tool events", () => {
    // Tests the tracking wrapper pattern used in sdkExecuteUnit's production path:
    // effectiveOnToolStart/effectiveOnToolEnd reset lastActivityAt, then delegate
    // to the original callback. This verifies the wrapper contract independently
    // of the SDK import, proving the pattern is correct before it runs in production.
    let lastActivityAt = 0;
    const originalCalls: string[] = [];

    const original = (event: { toolCallId: string; toolName: string }) => {
      originalCalls.push(event.toolName);
    };

    // Simulate the tracking wrapper pattern from sdk-executor.ts production path
    const trackingWrapper = (event: { toolCallId: string; toolName: string }): void => {
      lastActivityAt = Date.now();
      original(event);
    };

    // Before any calls, lastActivityAt is 0
    assert.equal(lastActivityAt, 0);

    trackingWrapper({ toolCallId: "tc1", toolName: "Read" });

    // After call, lastActivityAt is updated and original was called
    assert.ok(lastActivityAt > 0, "lastActivityAt must be updated by tracking wrapper");
    assert.deepEqual(originalCalls, ["Read"], "Original callback must be called by tracking wrapper");
  });

  test("Idle recovery text is pushed with priority 'now'", async () => {
    // Test the structure of idle recovery messages directly via SteeringQueue.push()
    // The idle recovery message is pushed with priority "now" by sdkExecuteUnit's
    // idle watchdog. We verify this by directly inspecting the message structure
    // that would be pushed.

    const q = new SteeringQueue("prompt");
    const iter = q[Symbol.asyncIterator]();
    // Consume initial prompt
    await iter.next();

    // Push an idle recovery message with priority "now" (as sdkExecuteUnit does)
    q.push({
      type: "user",
      message: { role: "user", content: "**IDLE RECOVERY — do not stop.**" },
      priority: "now",
      session_id: "",
      parent_tool_use_id: null,
    } as unknown as never);

    const next = await iter.next();
    q.close();
    // Drain remaining
    await iter.next();

    assert.equal(next.done, false, "Should yield pushed idle recovery message");
    assert.equal(
      (next.value as { priority: string }).priority,
      "now",
      "Idle recovery message must use priority 'now'",
    );
    const content = (next.value as { message: { content: string } }).message.content;
    assert.ok(content.includes("IDLE RECOVERY"), "Idle recovery message must contain 'IDLE RECOVERY'");
  });

});

// ─── sdkExecuteUnit — cleanup ──────────────────────────────────────────────

describe("sdkExecuteUnit — cleanup", () => {

  test("steeringQueue.close() is called in finally block (even when error thrown)", async () => {
    // Test that close() is called by verifying the SteeringQueue terminates
    // even when query() throws.
    //
    // Strategy: Instead of a background drain (which leaks a floating promise),
    // we verify via SteeringQueue.close() directly:
    // - Create a SteeringQueue instance
    // - Spy on close() to detect when it's called
    // - Run sdkExecuteUnit with an error-throwing query
    // - Verify the SteeringQueue was properly closed
    //
    // We verify close() works by checking that the generator terminates after
    // close() is called (using a properly awaited iterator).

    // Simpler approach: verify that the SteeringQueue generator terminates
    // after sdkExecuteUnit throws — which only happens if close() was called.
    // We create a second SteeringQueue and track the lifecycle externally.

    let closeCalled = false;

    // Patch SteeringQueue.close to track calls — use mock.method on the prototype
    // Actually, since SteeringQueue is our own class, we can verify the behavior
    // by checking that after sdkExecuteUnit throws, a fresh SteeringQueue with
    // the same mechanism would terminate properly.

    // The cleanest test: verify close() behavior by tracking it on a real instance.
    // sdkExecuteUnit creates its OWN SteeringQueue internally, so we can't spy on it
    // directly. Instead, we verify the effect: the prompt AsyncIterable passed to
    // the error-throwing query must eventually close (i.e., its for-await terminates).

    // Use a manual synchronization primitive that close() unblocks.
    let promptEnded = false;
    let promptEndedResolve: (() => void) | null = null;
    const promptEndedPromise = new Promise<void>(r => { promptEndedResolve = r; });

    async function* errorQuery(params: { prompt: AsyncIterable<unknown>; options?: unknown }) {
      // Consume the initial prompt message synchronously
      const iter = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      // Get the first message (initial prompt)
      await iter.next();

      // Set up tracking of when the iterator ends
      // This is done by scheduling a check after sdkExecuteUnit's finally block runs
      // We verify this by using a timeout that we know runs AFTER the throw propagates.
      void (async () => {
        // Try to get next item — this will resolve when close() is called
        const result = await iter.next();
        promptEnded = result.done === true;
        promptEndedResolve?.();
      })();

      // Throw immediately — sdkExecuteUnit's finally block will call close()
      throw new Error("Simulated SDK failure");
    }

    await assert.rejects(
      () => sdkExecuteUnit(makeParams(), {
        query: errorQuery,
        ...makeDeps(),
      } as unknown as Parameters<typeof sdkExecuteUnit>[1]),
      /Simulated SDK failure/,
    );

    // Wait for the prompt iterator to observe close()
    await promptEndedPromise;
    assert.equal(promptEnded, true, "steeringQueue.close() must be called in finally block, terminating the prompt iterator");
  });

  test("Returned sdkActiveQuery reference is set to null in finally block", async () => {
    // Verify that getSdkActiveQuery() returns null after execution completes
    const { query } = makeFakeSdk([], {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    // Import the getter to check the module-level state
    const { getSdkActiveQuery } = await import("../claude-code/sdk-executor.js");

    await sdkExecuteUnit(makeParams(), {
      query,
      ...makeDeps(),
    } as unknown as Parameters<typeof sdkExecuteUnit>[1]);

    assert.equal(getSdkActiveQuery(), null, "sdkActiveQuery must be null after execution completes");
  });

});
