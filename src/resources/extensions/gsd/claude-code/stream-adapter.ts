/**
 * stream-adapter.ts — Pi StreamSimple factory for the claude-code provider
 *
 * Purpose: Wraps the entire Claude Agent SDK `query()` session as a single
 * AssistantMessageEventStream, translating SDK events to Pi's event format.
 * This makes the SDK look like any other Pi stream provider from the agent
 * loop's perspective.
 *
 * Key behaviors:
 * - Tool visibility via Pi's native ctx.ui.setStatus() — set on PreToolUse,
 *   cleared on PostToolUse/PostToolUseFailure
 * - The LAST assistant message's text content is emitted as text_start/text_delta/
 *   text_end events — intermediate tool-heavy turns are invisible via text events
 *   (tool activity is visible via the status footer)
 * - Supervision uses SDK Query.interrupt()/close() for timeouts
 * - Activity writer captures all turns for crash recovery JSONL
 *
 * Critical invariants:
 * - Pitfall 3: Stop hook checks stop_hook_active before blocking (no infinite loop)
 * - Pitfall 6: persistSession: false (no accumulating session history)
 * - Pitfall 7: permissionMode: 'bypassPermissions' with allowDangerouslySkipPermissions: true
 */

import type { Api, Model, Context, SimpleStreamOptions, AssistantMessage, TextContent, Message } from "@gsd/pi-ai";
import { createAssistantMessageEventStream } from "@gsd/pi-ai";
import type { AssistantMessageEventStream } from "@gsd/pi-ai";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { SdkActivityWriter } from "./activity-writer.js";
import type { GsdProviderDeps } from "../provider-api/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** GSD tool event shape emitted by the hook bridge. */
interface GsdToolEvent {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  result?: unknown;
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
              tool_response: unknown;
            };

            if (input.hook_event_name !== "PostToolUse") return {};

            config.onToolEnd({
              toolCallId: input.tool_use_id,
              toolName: input.tool_name,
              result: input.tool_response,
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
export interface StreamAdapterDeps extends GsdProviderDeps {
  /** Pi extension context for native UI updates (tool status footer) */
  getCtx: () => { ui: { setStatus: (id: string, text: string | undefined) => void } } | null;
  /** Resolves a Pi model ID to an SDK model alias (e.g. "claude-code:claude-opus-4-6" → "opus") */
  resolveModelAlias: (modelId: string) => string;
  /** Creates the MCP server for custom tools from the shared registry */
  createMcpServer: () => Promise<unknown | undefined>;
}

// ─── User prompt extraction ──────────────────────────────────────────────────

/**
 * Extract the text content of the last user message from a Pi message array.
 * The system prompt is sent separately via options.systemPrompt; this extracts
 * the actual user prompt (task, query, etc.) that the SDK should process.
 */
function extractUserPrompt(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((c): c is TextContent => c.type === "text")
          .map(c => c.text)
          .join("\n");
      }
    }
  }
  return "";
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
      const sdkAlias = deps.resolveModelAlias(model.id);

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

      // ── User prompt ──────────────────────────────────────────────────────
      const userPrompt = extractUserPrompt(context.messages);

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
        // Wraps tool callbacks to reset idle clock and update Pi's native
        // status footer for tool visibility.
        const hookBridge = createHookBridge({
          onToolStart: (event: GsdToolEvent) => {
            lastActivityAt = Date.now();
            deps.onToolStart(event.toolCallId);
            const ctx = deps.getCtx();
            if (ctx) ctx.ui.setStatus("claude-code-tool", event.toolName.toLowerCase());
          },
          onToolEnd: (event: GsdToolEvent) => {
            lastActivityAt = Date.now();
            deps.onToolEnd(event.toolCallId);
            const ctx = deps.getCtx();
            if (ctx) ctx.ui.setStatus("claude-code-tool", undefined);
          },
          shouldBlockContextWrite: deps.shouldBlockContextWrite,
          getMilestoneId: deps.getMilestoneId,
          isDepthVerified: deps.isDepthVerified,
        });

        // ── MCP server ────────────────────────────────────────────────────────
        const mcpServer = await deps.createMcpServer();

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
          includePartialMessages: true,
          // NOTE: maxTurns is intentionally NOT set — GSD uses time-based supervision
          // via the steering channel. Setting maxTurns would conflict with the locked
          // decision to use soft/idle/hard timeouts only.
        };

        // ── Supervision timers ─────────────────────────────────────────────────
        // Uses SDK Query.interrupt() (graceful) and Query.close() (forceful)
        // instead of injecting text messages via the prompt iterable.

        // Soft timeout — graceful interrupt lets the agent finish its current thought
        if (softTimeoutMs > 0) {
          wrapupWarningHandle = setTimeout(() => {
            wrapupWarningHandle = null;
            if (queryObj?.interrupt) void queryObj.interrupt();
          }, softTimeoutMs);
        }

        // Idle watchdog — fires every 15 seconds, interrupts when idle.
        // lastActivityAt is reset by hook bridge callbacks so tool activity
        // prevents spurious firing.
        if (idleTimeoutMs > 0) {
          idleWatchdogHandle = setInterval(() => {
            const idleMs = Date.now() - lastActivityAt;
            if (idleMs < idleTimeoutMs) return;
            if (queryObj?.interrupt) void queryObj.interrupt();
            lastActivityAt = Date.now();
          }, 15000);
        }

        // Hard timeout — forceful close terminates the session immediately
        if (hardTimeoutMs > 0) {
          hardTimeoutHandle = setTimeout(() => {
            hardTimeoutHandle = null;
            queryObj?.close?.();
          }, hardTimeoutMs);
        }

        // ── Emit start BEFORE query loop (same as streamAnthropic) ────────────
        stream.push({ type: "start", partial: output });

        // Track current text content block index for streaming deltas
        let activeContentIndex = -1;

        queryObj = query({
          prompt: userPrompt,
          options: queryOptions as unknown as Record<string, unknown>,
        });

        for await (const msg of queryObj) {
          const sdkMsg = msg as Record<string, unknown>;

          if (sdkMsg["type"] === "stream_event") {
            // SDK streaming event — contains BetaRawMessageStreamEvent
            const event = sdkMsg["event"] as Record<string, unknown> | undefined;
            if (!event) continue;

            const eventType = event["type"] as string;

            if (eventType === "content_block_start") {
              const contentBlock = event["content_block"] as Record<string, unknown> | undefined;
              if (contentBlock?.["type"] === "text") {
                const textBlock: TextContent = { type: "text", text: "" };
                output.content.push(textBlock);
                activeContentIndex = output.content.length - 1;
                stream.push({ type: "text_start", contentIndex: activeContentIndex, partial: output });
              }
            } else if (eventType === "content_block_delta") {
              const delta = event["delta"] as Record<string, unknown> | undefined;
              if (delta?.["type"] === "text_delta" && activeContentIndex >= 0) {
                const text = String(delta["text"] ?? "");
                const block = output.content[activeContentIndex];
                if (block && block.type === "text") {
                  block.text += text;
                }
                stream.push({ type: "text_delta", contentIndex: activeContentIndex, delta: text, partial: output });
              }
            } else if (eventType === "content_block_stop") {
              if (activeContentIndex >= 0) {
                const block = output.content[activeContentIndex];
                const text = block && block.type === "text" ? block.text : "";
                stream.push({ type: "text_end", contentIndex: activeContentIndex, content: text, partial: output });
                activeContentIndex = -1;
              }
            }
          } else if (sdkMsg["type"] === "assistant") {
            // Full assistant turn message — capture session_id, feed activity writer
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

        // ── Close any unclosed text block ──────────────────────────────────────
        if (activeContentIndex >= 0) {
          const block = output.content[activeContentIndex];
          const text = block && block.type === "text" ? block.text : "";
          stream.push({ type: "text_end", contentIndex: activeContentIndex, content: text, partial: output });
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
