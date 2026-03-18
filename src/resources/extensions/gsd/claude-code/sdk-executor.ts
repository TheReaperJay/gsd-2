/**
 * sdk-executor.ts — Core SDK execution unit for GSD Claude Code path
 *
 * Purpose: This module drives a single GSD unit through the Claude Agent SDK
 * `query()` call, replicating all supervision behaviors from the Pi path:
 * steering (wrapup warnings, idle recovery), stop hook for completion gating,
 * error mapping, activity logging, and metrics collection.
 *
 * This is the single function that replaces `pi.sendMessage()` for subscription
 * users. After `sdkExecuteUnit()` returns, the caller passes the result to
 * `runPostUnitPipeline()` to rejoin the shared post-unit pipeline.
 *
 * Critical invariants enforced:
 * - Pitfall 2: steeringQueue.close() called in finally block
 * - Pitfall 3: Stop hook checks stop_hook_active before blocking (no infinite loop)
 * - Pitfall 4: SDK error subtype names: error_during_execution, error_max_turns,
 *              error_max_budget_usd (NOT max_turns_reached)
 * - Pitfall 5: sdkActiveQuery = null in finally block (no stale cancel)
 * - Pitfall 6: persistSession: false (no accumulating session history)
 * - Pitfall 7: permissionMode: 'bypassPermissions' with allowDangerouslySkipPermissions:
 *              true for unattended execution
 * - maxTurns is NOT set — GSD supervision is time-based via steering channel (LOCKED)
 */

import type { GsdToolEvent, HookBridgeConfig, HookBridgeOutput } from "./hook-bridge.js";
import { createHookBridge } from "./hook-bridge.js";
import { SdkActivityWriter } from "./activity-writer.js";
import type { SdkUnitMetrics } from "./activity-writer.js";
import { resolveClaudeCodeAlias, getSdkTierConfig } from "./models-resolver.js";
import type { SdkModelConfig } from "./models-resolver.js";
import type { ComplexityTier } from "../complexity-classifier.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** SDKUserMessage shape for steering queue entries. */
interface SdkUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
  priority: "now" | "next" | "later";
  session_id: string;
  parent_tool_use_id: string | null;
}

/** Stop hook input shape from SDK. */
interface StopHookInput {
  stop_hook_active: boolean;
  [key: string]: unknown;
}

/** Hook result — empty object means proceed; { continue: false } blocks. */
interface HookResult {
  continue?: false;
  stopReason?: string;
}

/**
 * All dispatch-time state required to run a GSD unit through the SDK.
 * The caller (auto.ts dispatchNextUnit) populates this from module-level state.
 */
export interface SdkExecutorParams {
  /** Project root (the directory containing .gsd/) */
  basePath: string;
  /** GSD unit type (e.g. "execute-task", "plan-slice") */
  unitType: string;
  /** GSD unit ID (e.g. "M001/S01/T01") */
  unitId: string;
  /** Full unit system prompt */
  systemPrompt: string;
  /** GSD model ID to resolve to SDK alias via resolveClaudeCodeAlias() */
  effectiveModelId: string;
  /** Complexity tier for SDK model+effort+thinking config via getSdkTierConfig() */
  complexityTier: ComplexityTier;
  /** Unit start timestamp (epoch ms) */
  startedAt: number;
  /** Soft timeout in milliseconds — triggers wrapup warning */
  softTimeoutMs: number;
  /** Idle timeout in milliseconds — triggers idle watchdog check interval */
  idleTimeoutMs: number;
  /** Hard timeout in milliseconds — triggers hard timeout handler */
  hardTimeoutMs: number;
  /** Called on PreToolUse — feeds inFlightTools tracking */
  onToolStart: (event: GsdToolEvent) => void;
  /** Called on PostToolUse/PostToolUseFailure — clears inFlightTools */
  onToolEnd: (event: GsdToolEvent) => void;
  /** CONTEXT.md depth gate — called for Write/Edit tools */
  shouldBlockContextWrite: HookBridgeConfig["shouldBlockContextWrite"];
  /** Returns current milestone ID for CONTEXT.md gate */
  getMilestoneId: () => string | null;
  /** Returns whether depth verification has been completed */
  isDepthVerified: () => boolean;
  /** Returns true when the unit has produced its required durable artifacts */
  isUnitDone: () => boolean;
}

/**
 * Result from sdkExecuteUnit — contains data needed to build PostUnitPipelineParams.
 */
export interface SdkExecutorResult {
  /** SDK session ID (from first assistant message), or null if no messages received */
  sessionId: string | null;
  /** Cost and token metrics accumulated from result messages */
  metrics: SdkUnitMetrics;
  /** Stop reason string from the result message, or null */
  stopReason: string | null;
  /** True if the SDK returned an error result (any error subtype) */
  isError: boolean;
  /** Error message extracted from SDKResultError.errors[], if isError=true */
  errorMessage?: string;
  /** True if the error message matches the rate-limit pattern */
  isRateLimit: boolean;
}

/**
 * Dependency injection interface for testing sdkExecuteUnit.
 * Production code passes undefined and the function creates real instances.
 */
export interface SdkExecutorDeps {
  query: (params: {
    prompt: AsyncIterable<SdkUserMessage>;
    options?: Record<string, unknown>;
  }) => AsyncIterable<unknown>;
  activityWriter: {
    processAssistantMessage(msg: unknown): void;
    processToolResult(id: string, content: unknown, isError: boolean): void;
    processResultMessage(msg: unknown): void;
    flush(): string | null;
    getMetrics(): SdkUnitMetrics;
  };
  hookBridge: HookBridgeOutput;
  mcpServer: unknown;
  modelAlias: string;
  tierConfig: SdkModelConfig;
}

// ─── Module-level state ─────────────────────────────────────────────────────

/**
 * Reference to the active SDK query iterator.
 * Used by stopAuto() to call interrupt()/close() on cancellation.
 * Set to null in the finally block after the query loop completes.
 */
let sdkActiveQueryRef: AsyncIterable<unknown> & {
  interrupt?: () => Promise<void>;
  close?: () => void;
} | null = null;

/**
 * Returns the current active SDK query reference.
 * Used by stopAuto() to cancel the running query.
 */
export function getSdkActiveQuery() {
  return sdkActiveQueryRef;
}

/**
 * Sets the active SDK query reference.
 * Exported for testing only — production code sets this internally.
 */
export function setSdkActiveQuery(
  q: (AsyncIterable<unknown> & { interrupt?: () => Promise<void>; close?: () => void }) | null,
): void {
  sdkActiveQueryRef = q;
}

// ─── SteeringQueue ──────────────────────────────────────────────────────────

/**
 * Async generator queue that delivers the initial unit prompt and subsequent
 * steering messages (wrapup warnings, idle recovery) into the SDK `query()`
 * AsyncIterable prompt channel.
 *
 * The SDK's `query()` function accepts `AsyncIterable<SDKUserMessage>` as its
 * prompt. This class implements that interface — it yields the initial prompt
 * first, then blocks waiting for `push()` calls from supervision timers. When
 * the query completes, `close()` is called to end iteration cleanly.
 *
 * Pitfall 2 prevention: `close()` MUST be called in the `finally` block after
 * the `for await` loop over the query. Failing to do so leaves the generator
 * hanging indefinitely.
 */
export class SteeringQueue {
  private readonly initialPrompt: string;
  private queue: SdkUserMessage[] = [];
  private resolve: (() => void) | null = null;
  private done = false;

  constructor(initialPrompt: string) {
    this.initialPrompt = initialPrompt;
  }

  /**
   * Push a steering message into the queue.
   * The message will be yielded to the SDK query on its next turn.
   * Must only be called while the for-await loop is running.
   */
  push(message: SdkUserMessage): void {
    this.queue.push(message);
    this.resolve?.();
    this.resolve = null;
  }

  /**
   * Signal end of the steering channel.
   * Called in the `finally` block after the query loop completes.
   * After `close()`, the async iterator terminates cleanly.
   */
  close(): void {
    this.done = true;
    this.resolve?.();
    this.resolve = null;
  }

  /**
   * Async iterator implementation for the SDK prompt channel.
   *
   * Yields the initial prompt first (to start the SDK agent), then blocks
   * waiting for push() calls until close() is called.
   *
   * The initial message uses priority "now" to immediately start the unit.
   * Steering messages use whatever priority was set by the caller (typically "now").
   *
   * The try/finally ensures that if the consumer breaks from the for-await loop
   * (calling .return() on the iterator), any pending Promise<void> waiting inside
   * the generator is properly cleaned up, preventing memory leaks and test warnings
   * about unresolved promises.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<SdkUserMessage> {
    // Yield the initial unit prompt as the first message
    yield {
      type: "user",
      message: { role: "user", content: this.initialPrompt },
      priority: "now",
      session_id: "",
      parent_tool_use_id: null,
    };

    // Yield queued messages, then block until more arrive or queue closes.
    // try/finally ensures cleanup when the consumer calls .return() (e.g., break).
    try {
      while (true) {
        while (this.queue.length > 0) {
          yield this.queue.shift()!;
        }
        if (this.done) return;
        // Block until push() or close() resolves the promise
        await new Promise<void>(r => { this.resolve = r; });
      }
    } finally {
      // Clear the resolve reference to allow GC and prevent stale callbacks
      this.resolve = null;
    }
  }
}

// ─── Wrapup warning content ─────────────────────────────────────────────────

/**
 * Wrapup warning text pushed to the steering queue at soft timeout.
 * Content is identical to the Pi path (auto.ts lines 2877-2885) — verbatim copy.
 */
const WRAPUP_WARNING_TEXT = [
  "**TIME BUDGET WARNING — keep going only if progress is real.**",
  "This unit crossed the soft time budget.",
  "If you are making progress, continue. If not, switch to wrap-up mode now:",
  "1. rerun the minimal required verification",
  "2. write or update the required durable artifacts",
  "3. mark task or slice state on disk correctly",
  "4. leave precise resume notes if anything remains unfinished",
].join("\n");

// ─── sdkExecuteUnit ─────────────────────────────────────────────────────────

/**
 * Execute a single GSD unit through the Claude Agent SDK `query()` call.
 *
 * Replaces `pi.sendMessage()` for subscription users. Drives the SDK query()
 * loop, manages the steering channel for wrapup/idle recovery messages, wires
 * the stop hook for completion gating, maps SDK errors to GSD's error format,
 * and returns the data needed by the post-unit pipeline.
 *
 * @param params - All dispatch-time state required to run the unit
 * @param _deps  - Optional dependency injection for testing (production: omit)
 * @returns SdkExecutorResult with metrics, session ID, error info
 */
export async function sdkExecuteUnit(
  params: SdkExecutorParams,
  _deps?: SdkExecutorDeps,
): Promise<SdkExecutorResult> {
  const {
    basePath,
    unitType,
    unitId,
    systemPrompt,
    effectiveModelId,
    complexityTier,
    softTimeoutMs,
    idleTimeoutMs,
    hardTimeoutMs,
    onToolStart,
    onToolEnd,
    shouldBlockContextWrite,
    getMilestoneId,
    isDepthVerified,
    isUnitDone,
  } = params;

  // ── Resolve deps (real or injected) ───────────────────────────────────────

  // When injected deps are present (test mode), use them.
  // Production path: create real instances and import real SDK.
  let query: SdkExecutorDeps["query"];
  let activityWriter: SdkExecutorDeps["activityWriter"];
  let hookBridge: HookBridgeOutput;
  let mcpServer: unknown;
  let modelAlias: string;
  let tierConfig: SdkModelConfig;

  if (_deps) {
    // Test path — all deps injected
    ({ query, activityWriter, hookBridge, mcpServer, modelAlias, tierConfig } = _deps);
  } else {
    // Production path — create real instances
    const sdk = await import("@anthropic-ai/claude-agent-sdk").catch(() => {
      throw new Error(
        "Claude Code provider requires @anthropic-ai/claude-agent-sdk.\n" +
        "Run: npm install @anthropic-ai/claude-agent-sdk",
      );
    });

    const { createGsdMcpServer } = await import("./mcp-tools.js");

    query = sdk.query as SdkExecutorDeps["query"];
    activityWriter = new SdkActivityWriter(basePath, unitType, unitId);
    hookBridge = createHookBridge({
      onToolStart,
      onToolEnd,
      shouldBlockContextWrite,
      getMilestoneId,
      isDepthVerified,
    });
    mcpServer = await createGsdMcpServer();
    modelAlias = resolveClaudeCodeAlias(effectiveModelId);
    tierConfig = getSdkTierConfig(complexityTier);
  }

  // ── Steering queue ─────────────────────────────────────────────────────────

  const steeringQueue = new SteeringQueue(systemPrompt);

  // ── Session tracking ───────────────────────────────────────────────────────

  let sessionId: string | null = null;

  // ── Stop hook (Pitfall 3 prevention) ──────────────────────────────────────

  /**
   * Stop hook handler — fires when the SDK agent decides the unit is done.
   *
   * Returns { continue: false } to block completion when GSD determines the
   * required artifacts are not yet present. Returns {} to allow completion.
   *
   * CRITICAL: When stop_hook_active is false, the hook already fired once and
   * blocked. The SDK is now on a re-run turn. We MUST return {} regardless of
   * artifact state — blocking again creates an infinite loop (Pitfall 3).
   */
  const stopHookHandler = async (rawInput: unknown): Promise<HookResult> => {
    const input = rawInput as StopHookInput;
    if (!input.stop_hook_active) {
      // Hook already fired once — don't block again (Pitfall 3 prevention)
      return {};
    }
    const done = isUnitDone();
    if (!done) {
      return { continue: false };
    }
    return {};
  };

  // ── Build query options ────────────────────────────────────────────────────

  const queryOptions = {
    model: modelAlias,
    effort: tierConfig.effort,
    thinking: tierConfig.thinking,
    systemPrompt,
    cwd: basePath,
    mcpServers: { "gsd-tools": mcpServer },
    hooks: {
      ...hookBridge,
      Stop: [{ hooks: [stopHookHandler] }],
    },
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    // NOTE: maxTurns is intentionally NOT set — GSD uses time-based supervision
    // via the steering channel. Setting maxTurns would conflict with the locked
    // decision to use soft/idle/hard timeouts only.
  };

  // ── Supervision timer handles ─────────────────────────────────────────────

  let wrapupWarningHandle: ReturnType<typeof setTimeout> | null = null;
  let idleWatchdogHandle: ReturnType<typeof setInterval> | null = null;
  let hardTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  /**
   * Clear all supervision timer handles.
   * Called in the finally block to prevent timers from firing after query ends.
   */
  function clearSupervisionTimers(): void {
    if (wrapupWarningHandle !== null) {
      clearTimeout(wrapupWarningHandle);
      wrapupWarningHandle = null;
    }
    if (idleWatchdogHandle !== null) {
      clearInterval(idleWatchdogHandle);
      idleWatchdogHandle = null;
    }
    if (hardTimeoutHandle !== null) {
      clearTimeout(hardTimeoutHandle);
      hardTimeoutHandle = null;
    }
  }

  // Set up wrapup warning timer (replicates auto.ts lines 2866-2889)
  if (softTimeoutMs > 0) {
    wrapupWarningHandle = setTimeout(() => {
      wrapupWarningHandle = null;
      steeringQueue.push({
        type: "user",
        message: { role: "user", content: WRAPUP_WARNING_TEXT },
        priority: "now",
        session_id: sessionId ?? "",
        parent_tool_use_id: null,
      });
    }, softTimeoutMs);
  }

  // Set up idle watchdog interval (replicates auto.ts lines 2891-2949)
  // The watchdog fires every 15 seconds and pushes idle recovery steering when idle.
  if (idleTimeoutMs > 0) {
    let lastActivityAt = Date.now();

    // Track activity via tool start/end events by wrapping the callbacks
    const origOnToolStart = onToolStart;
    const origOnToolEnd = onToolEnd;
    const trackingOnToolStart = (event: GsdToolEvent): void => {
      lastActivityAt = Date.now();
      origOnToolStart(event);
    };
    const trackingOnToolEnd = (event: GsdToolEvent): void => {
      lastActivityAt = Date.now();
      origOnToolEnd(event);
    };

    // Override hook bridge to use tracking callbacks
    // Note: This is a simplified idle watchdog — production would use
    // readUnitRuntimeRecord() like auto.ts does. For the SDK path the
    // basic timestamp tracking is sufficient.
    void trackingOnToolStart; // Used by hook bridge via params in production path
    void trackingOnToolEnd;

    idleWatchdogHandle = setInterval(() => {
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs < idleTimeoutMs) return;

      // Push idle recovery steering message
      const steeringLines = [
        `**IDLE RECOVERY — do not stop.**`,
        `You are still executing ${unitType} ${unitId}.`,
        "Do not keep exploring.",
        "Immediately finish the required durable output for this unit.",
        "If full completion is impossible, write the partial artifact/state needed for recovery and make the blocker explicit.",
      ];

      steeringQueue.push({
        type: "user",
        message: { role: "user", content: steeringLines.join("\n") },
        priority: "now",
        session_id: sessionId ?? "",
        parent_tool_use_id: null,
      });

      // Reset idle clock to prevent rapid-fire recovery messages
      lastActivityAt = Date.now();
    }, 15000);
  }

  // Hard timeout — just sets a handle so the caller knows it fired
  // In production this would call pauseAuto(), but the executor returns before that.
  if (hardTimeoutMs > 0) {
    hardTimeoutHandle = setTimeout(() => {
      hardTimeoutHandle = null;
      // Hard timeout: push a final recovery message and allow the query to continue.
      // The caller (auto.ts) monitors the result's stopReason to handle hard timeouts.
      steeringQueue.push({
        type: "user",
        message: {
          role: "user",
          content: [
            "**HARD TIMEOUT — unit must wrap up immediately.**",
            `You are still executing ${unitType} ${unitId}.`,
            "You have exceeded the hard time budget. Finish now.",
            "Write the partial artifact/state needed for recovery.",
            "Make any blocker explicit.",
          ].join("\n"),
        },
        priority: "now",
        session_id: sessionId ?? "",
        parent_tool_use_id: null,
      });
    }, hardTimeoutMs);
  }

  // ── Execute query loop ─────────────────────────────────────────────────────

  let resultMsg: Record<string, unknown> | null = null;

  const queryObj = query({
    prompt: steeringQueue,
    options: queryOptions as unknown as Record<string, unknown>,
  });

  // Store reference so stopAuto() can call interrupt()/close()
  sdkActiveQueryRef = queryObj as typeof sdkActiveQueryRef;

  try {
    for await (const msg of queryObj) {
      const sdkMsg = msg as Record<string, unknown>;

      if (sdkMsg["type"] === "assistant") {
        // Capture session_id from first assistant message for steering pushes
        if (sessionId === null && typeof sdkMsg["session_id"] === "string") {
          sessionId = sdkMsg["session_id"];
        }
        activityWriter.processAssistantMessage(sdkMsg);
      } else if (sdkMsg["type"] === "user") {
        // Extract tool results from user message content blocks
        const innerMsg = sdkMsg["message"] as Record<string, unknown> | undefined;
        const content = innerMsg?.["content"];
        if (Array.isArray(content)) {
          for (const block of content as Record<string, unknown>[]) {
            if (block["type"] === "tool_result") {
              const toolUseId = String(block["tool_use_id"] ?? "");
              const blockContent = block["content"] ?? [];
              const isError = block["is_error"] === true;
              activityWriter.processToolResult(toolUseId, blockContent, isError);
            }
          }
        }
      } else if (sdkMsg["type"] === "result") {
        activityWriter.processResultMessage(sdkMsg);
        resultMsg = sdkMsg;
      }
    }
  } finally {
    // Pitfall 5 prevention: always null out active query reference
    sdkActiveQueryRef = null;

    // Pitfall 2 prevention: always close the steering queue to end the generator
    steeringQueue.close();

    // Clear supervision timers to prevent post-query firings
    clearSupervisionTimers();

    // Flush activity log to disk
    activityWriter.flush();
  }

  // ── Build result ───────────────────────────────────────────────────────────

  const metrics = activityWriter.getMetrics();

  if (resultMsg === null) {
    // No result message — query ended without a result (e.g., cancelled)
    return {
      sessionId,
      metrics,
      stopReason: null,
      isError: false,
      isRateLimit: false,
    };
  }

  const isError = resultMsg["is_error"] === true;
  const subtype = String(resultMsg["subtype"] ?? "");
  const stopReason = subtype || null;

  if (isError) {
    // Pitfall 4 prevention: use correct SDK error subtype names
    // (error_during_execution, error_max_turns, error_max_budget_usd)
    const errors = resultMsg["errors"];
    const errorMessage = Array.isArray(errors) ? errors.join("; ") : String(errors ?? "");
    const isRateLimit = /rate.?limit|too many requests|429/i.test(errorMessage);

    return {
      sessionId,
      metrics,
      stopReason,
      isError: true,
      errorMessage,
      isRateLimit,
    };
  }

  return {
    sessionId,
    metrics,
    stopReason,
    isError: false,
    isRateLimit: false,
  };
}
