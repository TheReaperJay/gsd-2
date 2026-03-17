/**
 * hook-bridge.ts — Translates SDK PreToolUse/PostToolUse/PostToolUseFailure hooks into
 * GSD's internal tool event format.
 *
 * Purpose: The TUI, idle watchdog (via inFlightTools), and CONTEXT.md depth gate all depend
 * on tool events in GSD's internal format. This bridge ensures Claude Code execution produces
 * identical event visibility to the Pi path.
 *
 * The bridge is designed as a pure configuration object factory — all dependencies are injected
 * via HookBridgeConfig to avoid circular imports and keep the module testable in isolation.
 *
 * Critical invariants:
 * - PostToolUseFailure MUST call onToolEnd to prevent stale inFlightTools entries (Pitfall 4)
 * - shouldBlockContextWrite receives lowercased tool name to match index.ts behavior
 * - Idle detection uses start/end timestamps only — SDKToolProgressMessage.elapsed_time_seconds
 *   is NOT used (per CONTEXT.md locked decision)
 */

/**
 * GSD tool event shape emitted by the hook bridge.
 * Matches the fields used by Pi's tool_call/tool_result/tool_execution_start/end events.
 */
export interface GsdToolEvent {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  isError?: boolean;
}

/**
 * Configuration for creating a hook bridge instance.
 * All side-effecting operations are injected to keep the bridge testable.
 */
export interface HookBridgeConfig {
  /**
   * Called on PreToolUse — maps to tool_call + tool_execution_start.
   * Consumer typically calls markToolStart(event.toolCallId) to feed inFlightTools tracking.
   */
  onToolStart: (event: GsdToolEvent) => void;
  /**
   * Called on PostToolUse/PostToolUseFailure — maps to tool_result + tool_execution_end.
   * Consumer typically calls markToolEnd(event.toolCallId) to clear inFlightTools.
   * CRITICAL: Must be called on BOTH PostToolUse and PostToolUseFailure to prevent stale entries.
   */
  onToolEnd: (event: GsdToolEvent) => void;
  /**
   * CONTEXT.md depth gate — called for Write/Edit tools only.
   * Returns { block: true } to abort the tool call before execution.
   * The toolName argument receives the SDK PascalCase name lowercased (e.g. "write", "edit").
   */
  shouldBlockContextWrite: (
    toolName: string,
    inputPath: string,
    milestoneId: string | null,
    depthVerified: boolean,
  ) => { block: boolean; reason?: string };
  /** Returns the current milestone ID for the CONTEXT.md gate. */
  getMilestoneId: () => string | null;
  /** Returns whether depth verification has been completed for the current milestone. */
  isDepthVerified: () => boolean;
}

/**
 * SDK hook handler result type.
 * Empty object {} means proceed; { continue: false } means abort the tool call.
 */
interface HookResult {
  continue?: false;
  stopReason?: string;
}

/** SDK hook arrays in the format Options.hooks expects. */
export interface HookBridgeOutput {
  PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<HookResult>> }>;
  PostToolUse: Array<{ hooks: Array<(input: unknown) => Promise<HookResult>> }>;
  PostToolUseFailure: Array<{ hooks: Array<(input: unknown) => Promise<HookResult>> }>;
}

/**
 * Create SDK-compatible hook configuration that translates PreToolUse/PostToolUse/PostToolUseFailure
 * events into GSD's internal tool event format.
 *
 * Usage with SDK query():
 * ```typescript
 * const bridge = createHookBridge({
 *   onToolStart: (e) => markToolStart(e.toolCallId),
 *   onToolEnd: (e) => markToolEnd(e.toolCallId),
 *   shouldBlockContextWrite,
 *   getMilestoneId: getDiscussionMilestoneId,
 *   isDepthVerified,
 * });
 *
 * for await (const msg of query({ prompt, options: { hooks: bridge } })) { ... }
 * ```
 */
export function createHookBridge(config: HookBridgeConfig): HookBridgeOutput {
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

            // Emit tool start — feeds inFlightTools tracking via consumer's onToolStart
            config.onToolStart({
              toolCallId: input.tool_use_id,
              toolName: input.tool_name,
              input: input.tool_input,
            });

            // CONTEXT.md write gate for Write and Edit tools only.
            // Note: SDK uses PascalCase; shouldBlockContextWrite expects lowercase.
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
            // If this is not called, stale entries in inFlightTools suppress idle detection
            // for the remainder of the session.
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
