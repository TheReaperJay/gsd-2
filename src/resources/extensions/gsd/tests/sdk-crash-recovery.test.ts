import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeLock, readCrashLock } from "../crash-recovery.ts";
import { synthesizeCrashRecovery } from "../session-forensics.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-sdk-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

// ─── Test 1: writeLock with undefined sessionFile ─────────────────────────

test("writeLock with undefined sessionFile creates lock where lock.sessionFile is undefined", () => {
  const base = makeTmpBase();
  try {
    writeLock(base, "execute-task", "M001/S01/T01", 2, undefined);
    const lock = readCrashLock(base);
    assert.ok(lock, "lock should exist");
    assert.equal(lock!.unitType, "execute-task");
    assert.equal(lock!.unitId, "M001/S01/T01");
    assert.equal(lock!.completedUnits, 2);
    assert.equal(lock!.sessionFile, undefined);
  } finally {
    cleanup(base);
  }
});

// ─── Test 2: synthesizeCrashRecovery reads SDK activity log when sessionFile is undefined ─

test("synthesizeCrashRecovery with undefined sessionFile reads activity log JSONL", () => {
  const base = makeTmpBase();
  try {
    // Create activity dir with a JSONL file in SDK activity writer format
    const activityDir = join(base, ".gsd", "activity");
    mkdirSync(activityDir, { recursive: true });

    // Format: translated tool_use -> toolCall blocks (from activity-writer.ts translateContentBlock)
    const jsonlLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            name: "Read",
            id: "tc_001",
            arguments: { path: "/src/app.ts" }
          }]
        }
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc_001",
          toolName: "Read",
          isError: false,
          content: "export function main() { ... }"
        }
      }),
    ].join("\n");

    writeFileSync(
      join(activityDir, "001-execute-task-M001-S01-T01.jsonl"),
      jsonlLines,
      "utf-8",
    );

    writeLock(base, "execute-task", "M001/S01/T01", 0, undefined);
    const lock = readCrashLock(base);
    assert.ok(lock, "lock should exist");

    // sessionFile is undefined — synthesizeCrashRecovery must fall through to readLastActivityLog
    const recovery = synthesizeCrashRecovery(
      base,
      lock!.unitType,
      lock!.unitId,
      lock!.sessionFile,  // undefined
      activityDir,
    );

    assert.ok(recovery, "recovery briefing should be non-null");
    assert.ok(recovery!.trace.toolCallCount > 0, `toolCallCount should be > 0, got ${recovery!.trace.toolCallCount}`);
    assert.ok(
      recovery!.trace.filesRead.includes("/src/app.ts"),
      `filesRead should include /src/app.ts, got: ${JSON.stringify(recovery!.trace.filesRead)}`,
    );
  } finally {
    cleanup(base);
  }
});

// ─── Test 3: synthesizeCrashRecovery with empty activity dir returns null or zero-trace ─

test("synthesizeCrashRecovery with undefined sessionFile and empty activity dir returns null or zero-trace recovery", () => {
  const base = makeTmpBase();
  try {
    const activityDir = join(base, ".gsd", "activity");
    mkdirSync(activityDir, { recursive: true });
    // No JSONL files in the directory

    const recovery = synthesizeCrashRecovery(
      base,
      "execute-task",
      "M001/S01/T01",
      undefined,  // sessionFile
      activityDir,
    );

    // Must be null or have zero tool calls — no forensic data available
    const isNullOrEmpty = recovery === null || recovery.trace.toolCallCount === 0;
    assert.ok(isNullOrEmpty, `expected null or zero toolCallCount, got: ${JSON.stringify(recovery?.trace.toolCallCount)}`);
  } finally {
    cleanup(base);
  }
});

// ─── Test 4: synthesizeCrashRecovery with undefined sessionFile and no activity dir ─

test("synthesizeCrashRecovery with undefined sessionFile and no activity dir returns null or zero-trace recovery", () => {
  const base = makeTmpBase();
  try {
    const recovery = synthesizeCrashRecovery(
      base,
      "execute-task",
      "M001/S01/T01",
      undefined,  // sessionFile
      undefined,  // activityDir
    );

    // Must be null or have zero tool calls — no forensic data available
    const isNullOrEmpty = recovery === null || recovery.trace.toolCallCount === 0;
    assert.ok(isNullOrEmpty, `expected null or zero toolCallCount, got: ${JSON.stringify(recovery?.trace.toolCallCount)}`);
  } finally {
    cleanup(base);
  }
});
