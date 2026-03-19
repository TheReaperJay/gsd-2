/**
 * stream-adapter.ts — Pi StreamSimple factory for the claude-code provider
 *
 * Purpose: Wraps the entire Claude Agent SDK `query()` session as a single
 * AssistantMessageEventStream, translating SDK events to Pi's event format.
 * This makes the SDK look like any other Pi stream provider from the agent
 * loop's perspective.
 *
 * Key behaviors:
 * - provider_tool_start/provider_tool_end events flow to the Pi stream from
 *   SDK hook callbacks, giving the agent loop visibility into mid-session tools
 * - The LAST assistant message's text content is emitted as text_start/text_delta/
 *   text_end events — intermediate tool-heavy turns are invisible via text events
 *   (already visible via provider_tool events from hooks)
 * - Supervision (steering queue, idle detection, soft/hard timeouts) is managed
 *   internally — callers see only the Pi stream
 * - Activity writer captures all turns for crash recovery JSONL
 *
 * Critical invariants:
 * - Pitfall 2: steeringQueue.close() called in finally block
 * - Pitfall 3: Stop hook checks stop_hook_active before blocking (no infinite loop)
 * - Pitfall 6: persistSession: false (no accumulating session history)
 * - Pitfall 7: permissionMode: 'bypassPermissions' with allowDangerouslySkipPermissions: true
 * - maxTurns is NOT set — GSD supervision is time-based via steering channel (LOCKED)
 */

import type { Api, Model, Context, SimpleStreamOptions, AssistantMessage, TextContent } from "@gsd/pi-ai";
import { createAssistantMessageEventStream } from "@gsd/pi-ai";
import { SteeringQueue, WRAPUP_WARNING_TEXT } from "./steering-queue.js";
import type { SdkUserMessage } from "./steering-queue.js";
import { SdkActivityWriter } from "./activity-writer.js";
import { createGsdMcpServer } from "./mcp-tools.js";
import type { AssistantMessageEventStream } from "@gsd/pi-ai";

// ─── ProviderModelData augmentation ─────────────────────────────────────────

declare module "@gsd/pi-ai" {
  interface ProviderModelData {
    "claude-code"?: { sdkAlias: string };
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** GSD tool event shape emitted by the hook bridge. */
interface GsdToolEvent {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  isError?: boolean;
}

/** Hook result — empty object means proceed; { continue: false } blocks. */
interface HookResult {
  continue?: false;
  stopReason?: string;
}

/** Hook bridge configuration — all side-effecting operations are injected. */
interface HookBridgeConfig {
  onToolStart: (event: GsdToolEvent) => void;
  onToolEnd: (event: GsdToolEvent) => void;
  shouldBlockContextWrite: (
    toolName: string,
    inputPath: string,
    milestoneId: string | null,
    depthVerified: boolean,
  ) => { block: boolean; reason?: string };
  getMilestoneId: () => string | null;
  isDepthVerified: () => boolean;
}

/** SDK hook arrays in the format Options.hooks expects. */
interface HookBridgeOutput {
  PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<HookResult>> }>;
  PostToolUse: Array<{ hooks: Array<(input: unknown) => Promise<HookResult>> }>;
  PostToolUseFailure: Array<{ hooks: Array<(input: unknown) => Promise<HookResult>> }>;
}

/**
 * Create SDK-compatible hook configuration that translates PreToolUse/PostToolUse/PostToolUseFailure
 * events into GSD's internal tool event format.
 */
function createHookBridge(config: HookBridgeConfig): HookBridgeOutput {
  return {
    PreToolUse: [
      {
        hooks: [
          async (rawInput: unknown): Promise<HookResult> => {
            const input = rawInput as {
              hook_event_name: string;
              tool_name: string;
              tool_input: unknown;
              tool_use_id: string;
            };

            if (input.hook_event_name !== "PreToolUse") return {};

            config.onToolStart({
              toolCallId: input.tool_use_id,
              toolName: input.tool_name,
              input: input.tool_input,
            });

            if (input.tool_name === "Write" || input.tool_name === "Edit") {
              const toolInput = input.tool_input as Record<string, unknown> | null | undefined;
              const filePath =
                (typeof toolInput?.file_path === "string" ? toolInput.file_path : undefined) ??
                (typeof toolInput?.path === "string" ? toolInput.path : undefined) ??
                "";

              const result = config.shouldBlockContextWrite(
                input.tool_name.toLowerCase(),
                filePath,
                config.getMilestoneId(),
                config.isDepthVerified(),
              );

              if (result.block) {
                return { continue: false, stopReason: result.reason };
              }
            }

            return {};
          },
        ],
      },
    ],

    PostToolUse: [
      {
        hooks: [
          async (rawInput: unknown): Promise<HookResult> => {
            const input = rawInput as {
              hook_event_name: string;
              tool_name: string;
              tool_use_id: string;
            };

            if (input.hook_event_name !== "PostToolUse") return {};

            config.onToolEnd({
              toolCallId: input.tool_use_id,
              toolName: input.tool_name,
              isError: false,
            });

            return {};
          },
        ],
      },
    ],

    PostToolUseFailure: [
      {
        hooks: [
          async (rawInput: unknown): Promise<HookResult> => {
            const input = rawInput as {
              hook_event_name: string;
              tool_name: string;
              tool_use_id: string;
            };

            if (input.hook_event_name !== "PostToolUseFailure") return {};

            // CRITICAL: Must clear inFlightTools on failure too (Pitfall 4 prevention).
            config.onToolEnd({
              toolCallId: input.tool_use_id,
              toolName: input.tool_name,
              isError: true,
            });

            return {};
          },
        ],
      },
    ],
  };
}

/** Stop hook input shape from SDK. */
interface StopHookInput {
  stop_hook_active: boolean;
  [key: string]: unknown;
}

/**
 * Dependencies injected into the stream adapter factory.
 *
 * All callbacks are resolved per invocation (not captured at factory creation
 * time) to avoid stale registration-time snapshots. The factory captures the
 * deps object at registration time, but callers (auto.ts/index.ts) set the
 * underlying values before each dispatch.
 */
export interface StreamAdapterDeps {
  /** Function to get supervisor config at call time (not captured at registration) */
  getSupervisorConfig: () => { soft_timeout_minutes?: number; idle_timeout_minutes?: number; hard_timeout_minutes?: number };
  /** CONTEXT.md write gate */
  shouldBlockContextWrite: (toolName: string, inputPath: string, milestoneId: string | null, depthVerified: boolean) => { block: boolean; reason?: string };
  /** Returns current milestone ID */
  getMilestoneId: () => string | null;
  /** Returns depth verification status */
  isDepthVerified: () => boolean;
  /** Returns whether the unit's required durable artifacts exist — resolved per invocation */
  getIsUnitDone: () => boolean;
  /** Tool event callbacks for TUI inFlightTools tracking */
  onToolStart: (toolCallId: string) => void;
  onToolEnd: (toolCallId: string) => void;
  /** Returns project base path — resolved per invocation */
  getBasePath: () => string;
  /** Returns unit type and ID for the current dispatch — resolved per invocation */
  getUnitInfo: () => { unitType: string; unitId: string };
}

// ─── createClaudeCodeStream ──────────────────────────────────────────────────

/**
 * Factory that creates a streamSimple function for the claude-code provider.
 *
 * The factory captures the deps object at registration time. Per-invocation
 * state (basePath, unitType, unitId, isUnitDone) is resolved by calling the
 * getter callbacks at call time — not captured at factory creation.
 *
 * @param deps - Injected dependencies for supervision, hooks, and activity logging
 * @returns A streamSimple function compatible with Pi's StreamFunction type
 */
export function createClaudeCodeStream(deps: StreamAdapterDeps): (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  return function streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();

    (async () => {
      // ── Resolve SDK alias ─────────────────────────────────────────────────
      const sdkAlias = (model.providerData?.["claude-code"]?.sdkAlias) ?? "sonnet";

      // ── Build output AssistantMessage (same structure as streamAnthropic) ─
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api as Api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };

      // ── Resolve per-invocation deps ───────────────────────────────────────
      const { unitType, unitId } = deps.getUnitInfo();
      const basePath = deps.getBasePath();
      const supervisor = deps.getSupervisorConfig();

      // ── Supervision timer config ──────────────────────────────────────────
      const softTimeoutMs = (supervisor.soft_timeout_minutes ?? 0) * 60 * 1000;
      const idleTimeoutMs = (supervisor.idle_timeout_minutes ?? 0) * 60 * 1000;
      const hardTimeoutMs = (supervisor.hard_timeout_minutes ?? 0) * 60 * 1000;

      // ── Steering queue ────────────────────────────────────────────────────
      const steeringQueue = new SteeringQueue(context.systemPrompt ?? "");

      // ── Session tracking ──────────────────────────────────────────────────
      let sessionId: string | null = null;

      // ── Activity writer ───────────────────────────────────────────────────
      const activityWriter = new SdkActivityWriter(basePath, unitType, unitId);

      // ── Idle tracking ─────────────────────────────────────────────────────
      // lastActivityAt must be declared before the try block so that both the
      // hook wrappers (inside try) and the idle watchdog setInterval share the
      // same variable.
      let lastActivityAt = Date.now();

      // ── Supervision timer handles ─────────────────────────────────────────
      // Declared before try block so the finally block can clear them.
      let wrapupWarningHandle: ReturnType<typeof setTimeout> | null = null;
      let idleWatchdogHandle: ReturnType<typeof setInterval> | null = null;
      let hardTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

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

      // ── AbortSignal handling ──────────────────────────────────────────────
      // Declared before try block so the abort listener can reference queryObj
      // which is set inside the try block.
      let queryObj: (AsyncIterable<unknown> & { interrupt?: () => Promise<void>; close?: () => void }) | null = null;

      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          if (queryObj?.interrupt) {
            void queryObj.interrupt();
          } else {
            queryObj?.close?.();
          }
        }, { once: true });
      }

      // ── Single try/catch/finally covering ALL async operations ────────────
      // This ensures the finally block always runs regardless of where the error
      // originates — including MCP server creation and SDK import.
      try {
        // ── Hook bridge ───────────────────────────────────────────────────────
        // Wraps tool callbacks to reset idle clock AND push provider_tool events
        // to the Pi stream.
        const hookBridge = createHookBridge({
          onToolStart: (event: GsdToolEvent) => {
            lastActivityAt = Date.now();
            deps.onToolStart(event.toolCallId);
            stream.push({
              type: "provider_tool_start",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.input,
            });
          },
          onToolEnd: (event: GsdToolEvent) => {
            lastActivityAt = Date.now();
            deps.onToolEnd(event.toolCallId);
            stream.push({
              type: "provider_tool_end",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.input ?? null,
              isError: event.isError ?? false,
            });
          },
          shouldBlockContextWrite: deps.shouldBlockContextWrite,
          getMilestoneId: deps.getMilestoneId,
          isDepthVerified: deps.isDepthVerified,
        });

        // ── MCP server ────────────────────────────────────────────────────────
        const mcpServer = await createGsdMcpServer();

        // ── Stop hook (Pitfall 3 prevention) ──────────────────────────────────
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
            return {};
          }
          if (!deps.getIsUnitDone()) {
            return { continue: false };
          }
          return {};
        };

        // ── Query options ──────────────────────────────────────────────────────
        const queryOptions = {
          model: sdkAlias,
          systemPrompt: context.systemPrompt ?? "",
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

        // ── Supervision timers ─────────────────────────────────────────────────

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
            } as SdkUserMessage);
          }, softTimeoutMs);
        }

        // Set up idle watchdog interval (replicates auto.ts lines 2891-2949)
        // Fires every 15 seconds and pushes idle recovery steering when idle.
        // lastActivityAt is reset by hook bridge callbacks so tool activity
        // prevents spurious firing.
        if (idleTimeoutMs > 0) {
          idleWatchdogHandle = setInterval(() => {
            const idleMs = Date.now() - lastActivityAt;
            if (idleMs < idleTimeoutMs) return;

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
            } as SdkUserMessage);

            lastActivityAt = Date.now();
          }, 15000);
        }

        // Hard timeout — push a final recovery message to the steering queue
        if (hardTimeoutMs > 0) {
          hardTimeoutHandle = setTimeout(() => {
            hardTimeoutHandle = null;
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
            } as SdkUserMessage);
          }, hardTimeoutMs);
        }

        // ── Import SDK dynamically ─────────────────────────────────────────────
        // Optional dependency — fails at call time with clear install instruction
        const sdk = await import("@anthropic-ai/claude-agent-sdk").catch(() => {
          throw new Error(
            "Claude Code provider requires @anthropic-ai/claude-agent-sdk.\n" +
            "Run: npm install @anthropic-ai/claude-agent-sdk",
          );
        });
        const query = sdk.query as (params: {
          prompt: AsyncIterable<SdkUserMessage>;
          options?: Record<string, unknown>;
        }) => AsyncIterable<unknown> & {
          interrupt?: () => Promise<void>;
          close?: () => void;
        };

        // Track the last assistant message — only its text blocks go into Pi stream
        let lastAssistantMsg: Record<string, unknown> | null = null;

        queryObj = query({
          prompt: steeringQueue,
          options: queryOptions as unknown as Record<string, unknown>,
        });

        for await (const msg of queryObj) {
          const sdkMsg = msg as Record<string, unknown>;

          if (sdkMsg["type"] === "assistant") {
            // Capture session_id from first assistant message for steering pushes
            if (sessionId === null && typeof sdkMsg["session_id"] === "string") {
              sessionId = sdkMsg["session_id"];
            }
            activityWriter.processAssistantMessage(sdkMsg);
            // Track the last assistant message — used to extract final text content
            lastAssistantMsg = sdkMsg;
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

            // Extract usage from result message
            const usage = sdkMsg["usage"] as Record<string, unknown> | undefined;
            const inputTokens = typeof usage?.["input_tokens"] === "number" ? usage["input_tokens"] : 0;
            const outputTokens = typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : 0;
            output.usage.input = inputTokens;
            output.usage.output = outputTokens;
            output.usage.totalTokens = inputTokens + outputTokens;

            // Determine stop reason from result subtype
            const subtype = String(sdkMsg["subtype"] ?? "");
            const isError = sdkMsg["is_error"] === true;
            if (isError) {
              output.stopReason = "error";
              const errors = sdkMsg["errors"];
              output.errorMessage = Array.isArray(errors) ? errors.join("; ") : String(errors ?? "");
            } else if (subtype === "success" || subtype === "") {
              output.stopReason = "stop";
            }
          }
        }

        // ── Emit text events from the final assistant message ──────────────────
        // Emit start first, then the final message's text content as stream events,
        // then done. Only text blocks from the last assistant message are emitted.
        // Intermediate turns are visible via provider_tool events from hooks.
        stream.push({ type: "start", partial: output });

        if (lastAssistantMsg !== null) {
          const innerMsg = lastAssistantMsg["message"] as Record<string, unknown> | undefined;
          const rawContent = innerMsg?.["content"];
          if (Array.isArray(rawContent)) {
            for (const block of rawContent as Record<string, unknown>[]) {
              if (block["type"] === "text") {
                const text = String(block["text"] ?? "");
                const textBlock: TextContent = { type: "text", text };
                output.content.push(textBlock);
                const contentIndex = output.content.length - 1;
                stream.push({ type: "text_start", contentIndex, partial: output });
                stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
                stream.push({ type: "text_end", contentIndex, content: text, partial: output });
              }
            }
          }
        }

        if (output.stopReason === "error") {
          stream.push({ type: "error", reason: "error", error: output });
        } else {
          stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
        }
        stream.end();
      } catch (err) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
        stream.end();
      } finally {
        // Pitfall 2 prevention: always close the steering queue to end the generator
        steeringQueue.close();
        // Clear supervision timers to prevent post-query firings
        clearSupervisionTimers();
        // Flush activity log to disk for crash recovery
        activityWriter.flush();
        // Clear query reference
        queryObj = null;
      }
    })();

    return stream;
  };
}
