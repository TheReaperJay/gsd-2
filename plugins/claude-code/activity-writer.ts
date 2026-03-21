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
 * - SDK tool_use_id → tool_name resolution via internal Map
 * - SDKResultMessage.total_cost_usd and .usage into SdkUnitMetrics
 */

import { writeSync, mkdirSync, readdirSync, openSync, closeSync, constants } from "node:fs";
import { join } from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────────

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
  return { translated: block };
}

// ─── SdkActivityWriter ─────────────────────────────────────────────────────

export class SdkActivityWriter {
  private readonly entries: unknown[] = [];
  private readonly toolNameMap = new Map<string, string>();
  private readonly metricsAccumulator: SdkUnitMetrics = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  private readonly activityDir: string;
  private readonly unitType: string;
  private readonly unitId: string;

  /**
   * @param activityDir - Absolute path to the activity log directory (e.g., /project/.gsd/activity)
   * @param unitType    - GSD unit type (e.g. "execute-task")
   * @param unitId      - GSD unit ID (e.g. "M001/S01/T01")
   */
  constructor(activityDir: string, unitType: string, unitId: string) {
    this.activityDir = activityDir;
    this.unitType = unitType;
    this.unitId = unitId;
  }

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

  getEntries(): unknown[] {
    return [...this.entries];
  }

  getMetrics(): SdkUnitMetrics {
    return { ...this.metricsAccumulator };
  }

  flush(): string | null {
    if (this.entries.length === 0) return null;

    try {
      mkdirSync(this.activityDir, { recursive: true });

      const safeUnitId = this.unitId.replace(/\//g, "-");
      const filePath = claimNextFilePath(this.activityDir, this.unitType, safeUnitId);

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
      return null;
    }
  }
}
