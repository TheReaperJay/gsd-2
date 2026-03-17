import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SdkActivityWriter } from "../claude-code/activity-writer.js";
import type { SdkUnitMetrics } from "../claude-code/activity-writer.js";
import { extractTrace } from "../session-forensics.js";

const tmpDirs: string[] = [];

function createBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-activity-writer-test-"));
  tmpDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── processAssistantMessage — text content ────────────────────────────────

test("processAssistantMessage with text content produces correct entry", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  const sdkMsg = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Let me think about this." },
      ],
    },
  };

  writer.processAssistantMessage(sdkMsg);

  const entries = writer.getEntries();
  assert.equal(entries.length, 1);

  const entry = entries[0] as Record<string, unknown>;
  assert.equal(entry.type, "message");

  const msg = entry.message as Record<string, unknown>;
  assert.equal(msg.role, "assistant");

  const content = msg.content as Record<string, unknown>[];
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "Let me think about this.");
});

// ─── processAssistantMessage — tool_use content ────────────────────────────

test("processAssistantMessage with tool_use content produces toolCall entry with correct fields", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  const sdkMsg = {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_abc123",
          name: "bash",
          input: { command: "ls -la" },
        },
      ],
    },
  };

  writer.processAssistantMessage(sdkMsg);

  const entries = writer.getEntries();
  assert.equal(entries.length, 1);

  const entry = entries[0] as Record<string, unknown>;
  assert.equal(entry.type, "message");

  const msg = entry.message as Record<string, unknown>;
  assert.equal(msg.role, "assistant");

  const content = msg.content as Record<string, unknown>[];
  assert.equal(content.length, 1);

  const block = content[0];
  // CRITICAL: SDK tool_use must be translated to toolCall (not tool_use)
  assert.equal(block.type, "toolCall");
  assert.equal(block.name, "bash");
  assert.equal(block.id, "toolu_abc123");
  // CRITICAL: SDK input must be translated to arguments
  assert.deepEqual(block.arguments, { command: "ls -la" });
  // CRITICAL: tool_use must NOT remain as-is
  assert.notEqual(block.type, "tool_use");
  assert.ok(!("input" in block), "input field must be renamed to arguments");
});

// ─── processAssistantMessage — mixed content ───────────────────────────────

test("processAssistantMessage with mixed text and tool_use content translates all blocks", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  const sdkMsg = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "I will run a command." },
        {
          type: "tool_use",
          id: "toolu_xyz999",
          name: "read",
          input: { file_path: "/some/file.ts" },
        },
      ],
    },
  };

  writer.processAssistantMessage(sdkMsg);

  const entries = writer.getEntries();
  assert.equal(entries.length, 1);

  const msg = (entries[0] as Record<string, unknown>).message as Record<string, unknown>;
  const content = msg.content as Record<string, unknown>[];
  assert.equal(content.length, 2);
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "toolCall");
  assert.equal(content[1].name, "read");
  assert.deepEqual(content[1].arguments, { file_path: "/some/file.ts" });
});

// ─── toolNameMap — tool_use_id to name resolution ─────────────────────────

test("processAssistantMessage records tool_use_id -> name in internal map for later resolution", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  const sdkMsg = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "toolu_map_test", name: "write", input: { file_path: "x.ts" } },
      ],
    },
  };

  writer.processAssistantMessage(sdkMsg);

  // Now processToolResult with the same ID — it must resolve the name
  writer.processToolResult("toolu_map_test", [{ type: "text", text: "ok" }], false);

  const entries = writer.getEntries();
  assert.equal(entries.length, 2);

  const resultEntry = entries[1] as Record<string, unknown>;
  const msg = resultEntry.message as Record<string, unknown>;
  assert.equal(msg.role, "toolResult");
  assert.equal(msg.toolName, "write");
});

// ─── processToolResult — known toolUseId ───────────────────────────────────

test("processToolResult with known toolUseId produces correct toolResult entry", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  // First register the tool via assistant message
  writer.processAssistantMessage({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "toolu_123", name: "bash", input: { command: "pwd" } },
      ],
    },
  });

  writer.processToolResult("toolu_123", [{ type: "text", text: "/home/user" }], false);

  const entries = writer.getEntries();
  assert.equal(entries.length, 2);

  const entry = entries[1] as Record<string, unknown>;
  assert.equal(entry.type, "message");

  const msg = entry.message as Record<string, unknown>;
  assert.equal(msg.role, "toolResult");
  assert.equal(msg.toolCallId, "toolu_123");
  assert.equal(msg.toolName, "bash");
  assert.equal(msg.isError, false);
  assert.deepEqual(msg.content, [{ type: "text", text: "/home/user" }]);
});

// ─── processToolResult — unknown toolUseId ────────────────────────────────

test("processToolResult with unknown toolUseId falls back to 'unknown' toolName", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  writer.processToolResult("toolu_orphan", [{ type: "text", text: "result" }], false);

  const entries = writer.getEntries();
  assert.equal(entries.length, 1);

  const msg = (entries[0] as Record<string, unknown>).message as Record<string, unknown>;
  assert.equal(msg.toolName, "unknown");
  assert.equal(msg.toolCallId, "toolu_orphan");
});

// ─── processToolResult — isError flag ─────────────────────────────────────

test("processToolResult passes through isError flag correctly", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  writer.processToolResult("toolu_err", [{ type: "text", text: "error output" }], true);

  const entries = writer.getEntries();
  const msg = (entries[0] as Record<string, unknown>).message as Record<string, unknown>;
  assert.equal(msg.isError, true);
});

// ─── processResultMessage — metrics extraction ────────────────────────────

test("processResultMessage extracts cost and token counts into metrics", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  const sdkResultMsg = {
    type: "result",
    subtype: "success",
    total_cost_usd: 0.00125,
    usage: { input_tokens: 1500, output_tokens: 300 },
  };

  writer.processResultMessage(sdkResultMsg);

  const metrics = writer.getMetrics();
  assert.equal(metrics.costUsd, 0.00125);
  assert.equal(metrics.inputTokens, 1500);
  assert.equal(metrics.outputTokens, 300);
});

test("processResultMessage accumulates metrics across multiple result messages", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  writer.processResultMessage({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.001,
    usage: { input_tokens: 1000, output_tokens: 200 },
  });

  writer.processResultMessage({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.002,
    usage: { input_tokens: 500, output_tokens: 100 },
  });

  const metrics = writer.getMetrics();
  assert.equal(metrics.costUsd, 0.003);
  assert.equal(metrics.inputTokens, 1500);
  assert.equal(metrics.outputTokens, 300);
});

// ─── getMetrics — initial state ───────────────────────────────────────────

test("getMetrics returns zero values before any result messages", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  const metrics = writer.getMetrics();
  assert.equal(metrics.costUsd, 0);
  assert.equal(metrics.inputTokens, 0);
  assert.equal(metrics.outputTokens, 0);
});

// ─── getEntries — ordering ────────────────────────────────────────────────

test("getEntries returns entries in insertion order (assistant before tool result)", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  writer.processAssistantMessage({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "toolu_order_test", name: "bash", input: { command: "echo hi" } },
      ],
    },
  });

  writer.processToolResult("toolu_order_test", [{ type: "text", text: "hi" }], false);

  const entries = writer.getEntries();
  assert.equal(entries.length, 2);

  const first = (entries[0] as Record<string, unknown>).message as Record<string, unknown>;
  const second = (entries[1] as Record<string, unknown>).message as Record<string, unknown>;

  assert.equal(first.role, "assistant");
  assert.equal(second.role, "toolResult");
});

test("getEntries returns a copy (mutation of result does not affect internal state)", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  writer.processAssistantMessage({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello" }] },
  });

  const entries1 = writer.getEntries();
  entries1.push({ injected: true });

  const entries2 = writer.getEntries();
  assert.equal(entries2.length, 1, "mutating returned array must not affect internal state");
});

// ─── flush — writes JSONL to .gsd/activity/ ───────────────────────────────

test("flush writes entries to .gsd/activity/NNN-unitType-unitId.jsonl", () => {
  const baseDir = createBaseDir();
  const writer = new SdkActivityWriter(baseDir, "execute-task", "T01");

  writer.processAssistantMessage({
    type: "assistant",
    message: { content: [{ type: "text", text: "flushed" }] },
  });

  const filePath = writer.flush();
  assert.ok(filePath !== null, "flush must return a file path");
  assert.ok(filePath!.includes(".gsd/activity/"), "file must be in .gsd/activity/");
  assert.ok(filePath!.match(/\d{3}-execute-task-T01\.jsonl$/), "file must follow NNN-unitType-unitId.jsonl pattern");

  const content = readFileSync(filePath!, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "must have one JSONL line");

  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(parsed.type, "message");
});

test("flush returns null when no entries", () => {
  const baseDir = createBaseDir();
  const writer = new SdkActivityWriter(baseDir, "execute-task", "T02");

  const result = writer.flush();
  assert.equal(result, null);
});

test("flush writes valid JSONL (one entry per line, each line parseable)", () => {
  const baseDir = createBaseDir();
  const writer = new SdkActivityWriter(baseDir, "execute-task", "T03");

  writer.processAssistantMessage({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "toolu_flush_test", name: "bash", input: { command: "ls" } },
      ],
    },
  });

  writer.processToolResult("toolu_flush_test", [{ type: "text", text: "file1.ts" }], false);

  const filePath = writer.flush();
  assert.ok(filePath !== null);

  const content = readFileSync(filePath!, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "must have two JSONL lines (assistant + tool result)");

  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `Line must be valid JSON: ${line}`);
  }
});

test("flush sequence numbers increment correctly for multiple flushes", () => {
  const baseDir = createBaseDir();

  const writer1 = new SdkActivityWriter(baseDir, "execute-task", "T01");
  writer1.processAssistantMessage({
    type: "assistant",
    message: { content: [{ type: "text", text: "first" }] },
  });
  const path1 = writer1.flush();

  const writer2 = new SdkActivityWriter(baseDir, "execute-task", "T02");
  writer2.processAssistantMessage({
    type: "assistant",
    message: { content: [{ type: "text", text: "second" }] },
  });
  const path2 = writer2.flush();

  assert.ok(path1!.includes("001-"), "first flush gets sequence 001");
  assert.ok(path2!.includes("002-"), "second flush gets sequence 002");
});

// ─── Round-trip test: extractTrace() parses writer output ─────────────────

test("round-trip: extractTrace() can parse writer output and returns correct toolCalls", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  // Add assistant message with a tool_use block
  writer.processAssistantMessage({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_roundtrip",
          name: "bash",
          input: { command: "echo hello" },
        },
      ],
    },
  });

  // Add the matching tool result
  writer.processToolResult(
    "toolu_roundtrip",
    [{ type: "text", text: "hello" }],
    false,
  );

  const entries = writer.getEntries();
  const trace = extractTrace(entries);

  assert.equal(trace.toolCalls.length, 1, "extractTrace must find one completed tool call");

  const toolCall = trace.toolCalls[0];
  assert.equal(toolCall.name, "bash", "tool name must be preserved through round-trip");
  assert.deepEqual(toolCall.input, { command: "echo hello" }, "tool input must be preserved through round-trip");
  assert.equal(toolCall.isError, false);
  assert.equal(toolCall.result, "hello");
});

test("round-trip: extractTrace() handles text reasoning in writer output", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  writer.processAssistantMessage({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "I am reasoning about the problem." },
      ],
    },
  });

  const entries = writer.getEntries();
  const trace = extractTrace(entries);

  assert.ok(trace.lastReasoning.includes("reasoning about the problem"), "lastReasoning must be captured");
});

test("round-trip: extractTrace() returns empty toolCalls for entries with no tool results", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");

  // Assistant message with tool_use but NO matching tool result
  writer.processAssistantMessage({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "toolu_no_result", name: "read", input: { file_path: "x.ts" } },
      ],
    },
  });

  const entries = writer.getEntries();
  const trace = extractTrace(entries);

  // extractTrace flushes pending tool calls without results
  assert.equal(trace.toolCalls.length, 1, "pending tool calls without results are flushed");
  assert.equal(trace.toolCalls[0].name, "read");
  // isError should be false for pending (unresolved) tool calls
  assert.equal(trace.toolCalls[0].isError, false);
});

test("round-trip: SdkUnitMetrics interface has required fields", () => {
  const writer = new SdkActivityWriter("/tmp/fake", "execute-task", "T01");
  const metrics: SdkUnitMetrics = writer.getMetrics();

  // Type check — ensure the interface has costUsd, inputTokens, outputTokens
  assert.ok("costUsd" in metrics, "SdkUnitMetrics must have costUsd");
  assert.ok("inputTokens" in metrics, "SdkUnitMetrics must have inputTokens");
  assert.ok("outputTokens" in metrics, "SdkUnitMetrics must have outputTokens");
});
