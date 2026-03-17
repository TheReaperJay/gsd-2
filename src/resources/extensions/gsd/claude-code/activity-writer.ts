/**
 * GSD Activity Writer — SDK message stream to JSONL activity log translator
 *
 * Translates SDK streaming messages (SDKAssistantMessage, SDKUserMessage) into
 * the JSONL entry format that session-forensics.ts extractTrace() can parse.
 * Also accumulates per-unit cost and token metrics from SDKResultMessage.
 *
 * Key translation responsibilities:
 * - SDK `type: "tool_use"` content blocks → GSD `type: "toolCall"` format
 * - SDK `input` field → GSD `arguments` field in toolCall entries
 * - SDK tool_use_id → tool_name resolution via internal Map (tool names are
 *   present in assistant messages but absent from user/tool-result messages)
 * - SDKResultMessage.total_cost_usd and .usage into SdkUnitMetrics
 *
 * Used by: sdk-executor.ts (Phase 3) — called during the for-await loop
 * over query() results, then flushed to disk after the unit completes.
 */

import { writeSync, mkdirSync, readdirSync, openSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "../paths.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Per-unit cost and token metrics extracted from SDKResultMessage.
 * For Claude Code subscription users, costUsd will be 0.0 — but tokens are
 * always tracked for budget-pressure downgrade decisions.
 */
export interface SdkUnitMetrics {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

const SEQ_PREFIX_RE = /^(\d+)-/;

function scanNextSequence(activityDir: string): number {
  let maxSeq = 0;
  try {
    for (const f of readdirSync(activityDir)) {
      const match = f.match(SEQ_PREFIX_RE);
      if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10));
    }
  } catch {
    return 1;
  }
  return maxSeq + 1;
}

/**
 * Atomically claim the next sequence number using O_CREAT | O_EXCL.
 * If a collision occurs (EEXIST), increments and retries — same pattern
 * as activity-log.ts nextActivityFilePath().
 */
function claimNextFilePath(
  activityDir: string,
  unitType: string,
  safeUnitId: string,
): string {
  let seq = scanNextSequence(activityDir);
  for (let attempts = 0; attempts < 1000; attempts++) {
    const seqStr = String(seq).padStart(3, "0");
    const filePath = join(activityDir, `${seqStr}-${unitType}-${safeUnitId}.jsonl`);
    try {
      const fd = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      closeSync(fd);
      return filePath;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        seq++;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to find available activity log sequence in ${activityDir}`);
}

/**
 * Translate a single SDK content block to the GSD JSONL format.
 *
 * SDK tool_use block: { type: "tool_use", id, name, input }
 * GSD toolCall block: { type: "toolCall", id, name, arguments }
 *
 * Text blocks pass through unchanged.
 * Returns the translated block and, if it was a tool_use block,
 * also the id->name mapping to record in the toolNameMap.
 */
function translateContentBlock(
  block: Record<string, unknown>,
): { translated: Record<string, unknown>; toolEntry?: { id: string; name: string } } {
  if (block.type === "tool_use") {
    const id = String(block.id ?? "");
    const name = String(block.name ?? "unknown");
    return {
      translated: {
        type: "toolCall",
        name,
        id,
        arguments: block.input ?? {},
      },
      toolEntry: { id, name },
    };
  }
  // Text blocks and any other block types pass through unchanged
  return { translated: block };
}

// ─── SdkActivityWriter ─────────────────────────────────────────────────────

/**
 * Translates SDK streaming messages into the JSONL format expected by
 * session-forensics.ts extractTrace().
 *
 * Usage in sdk-executor.ts:
 * ```typescript
 * const writer = new SdkActivityWriter(basePath, unitType, unitId);
 * for await (const msg of query({ prompt, options })) {
 *   if (msg.type === "assistant") writer.processAssistantMessage(msg);
 *   else if (msg.type === "user") {
 *     // extract tool result from msg and call processToolResult(...)
 *   }
 *   else if (msg.type === "result") writer.processResultMessage(msg);
 * }
 * writer.flush();
 * ```
 */
export class SdkActivityWriter {
  /** Accumulated JSONL entries — each entry is one line in the output file */
  private readonly entries: unknown[] = [];

  /**
   * Maps tool_use_id -> tool_name.
   * Populated when processing assistant messages with tool_use content blocks.
   * Consumed when processing tool result messages (which carry the ID but not the name).
   */
  private readonly toolNameMap = new Map<string, string>();

  /** Accumulated cost and token metrics from SDKResultMessage events */
  private readonly metricsAccumulator: SdkUnitMetrics = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  private readonly basePath: string;
  private readonly unitType: string;
  private readonly unitId: string;

  /**
   * @param basePath - Project root (the directory containing .gsd/)
   * @param unitType - GSD unit type (e.g. "execute-task", "plan-slice")
   * @param unitId   - GSD unit ID (e.g. "M001/S01/T01")
   */
  constructor(basePath: string, unitType: string, unitId: string) {
    this.basePath = basePath;
    this.unitType = unitType;
    this.unitId = unitId;
  }

  /**
   * Process an SDK assistant message, translating tool_use content blocks
   * to the toolCall format and appending the entry to the accumulator.
   *
   * SDK format: { type: "assistant", message: { content: ContentBlock[] } }
   * where ContentBlock is { type: "text", text } or { type: "tool_use", id, name, input }
   *
   * GSD format: { type: "message", message: { role: "assistant", content: [...] } }
   * where toolCall blocks use { type: "toolCall", name, id, arguments }
   *
   * Also records id->name in toolNameMap for use when processing tool results.
   */
  processAssistantMessage(sdkMsg: unknown): void {
    const msg = sdkMsg as Record<string, unknown>;
    const inner = msg.message as Record<string, unknown> | undefined;
    if (!inner) return;

    const rawContent = inner.content;
    if (!Array.isArray(rawContent)) return;

    const translatedContent: Record<string, unknown>[] = [];

    for (const block of rawContent as Record<string, unknown>[]) {
      const { translated, toolEntry } = translateContentBlock(block);
      translatedContent.push(translated);
      if (toolEntry) {
        this.toolNameMap.set(toolEntry.id, toolEntry.name);
      }
    }

    this.entries.push({
      type: "message",
      message: {
        role: "assistant",
        content: translatedContent,
      },
    });
  }

  /**
   * Process a tool result, resolving the tool name from the pending toolNameMap.
   *
   * Called with:
   * - toolUseId: the tool_use_id from the SDK user message
   * - content:   the tool result content (array of content blocks)
   * - isError:   whether the tool call failed
   *
   * The tool name is looked up from the toolNameMap (populated by processAssistantMessage).
   * If the ID is not in the map (orphaned result), "unknown" is used as the fallback.
   */
  processToolResult(toolUseId: string, content: unknown, isError: boolean): void {
    const toolName = this.toolNameMap.get(toolUseId) ?? "unknown";

    this.entries.push({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: toolUseId,
        toolName,
        isError,
        content,
      },
    });
  }

  /**
   * Process an SDK result message, accumulating cost and token metrics.
   * Metrics are added (not replaced) to support the case where multiple result
   * messages arrive for a single unit (e.g., sub-agents or error recovery).
   *
   * SDK format: { type: "result", total_cost_usd, usage: { input_tokens, output_tokens } }
   */
  processResultMessage(sdkMsg: unknown): void {
    const msg = sdkMsg as Record<string, unknown>;
    const costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
    const usage = msg.usage as Record<string, unknown> | undefined;
    const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;

    this.metricsAccumulator.costUsd += costUsd;
    this.metricsAccumulator.inputTokens += inputTokens;
    this.metricsAccumulator.outputTokens += outputTokens;
  }

  /**
   * Returns a copy of all accumulated JSONL entries in insertion order.
   * Entries are ordered: assistant messages before their matching tool results —
   * this is the natural order of the SDK stream, and the order that
   * session-forensics.ts extractTrace() requires.
   */
  getEntries(): unknown[] {
    return [...this.entries];
  }

  /**
   * Returns a copy of the accumulated cost and token metrics.
   */
  getMetrics(): SdkUnitMetrics {
    return { ...this.metricsAccumulator };
  }

  /**
   * Flush accumulated entries to disk as a JSONL file in .gsd/activity/.
   *
   * File naming follows the same pattern as activity-log.ts:
   *   .gsd/activity/NNN-unitType-unitId.jsonl
   * where NNN is a zero-padded 3-digit sequence number.
   *
   * Returns the file path on success, or null if there are no entries
   * or if writing fails (failure must not crash auto-mode).
   *
   * Each entry is written as one JSON line. The file is created atomically
   * using O_CREAT | O_EXCL to prevent sequence collisions with concurrent writers.
   */
  flush(): string | null {
    if (this.entries.length === 0) return null;

    try {
      const activityDir = join(gsdRoot(this.basePath), "activity");
      mkdirSync(activityDir, { recursive: true });

      const safeUnitId = this.unitId.replace(/\//g, "-");
      const filePath = claimNextFilePath(activityDir, this.unitType, safeUnitId);

      const fd = openSync(filePath, "w");
      try {
        for (const entry of this.entries) {
          writeSync(fd, JSON.stringify(entry) + "\n");
        }
      } finally {
        closeSync(fd);
      }

      return filePath;
    } catch {
      // Activity logging must never crash auto-mode
      return null;
    }
  }
}
