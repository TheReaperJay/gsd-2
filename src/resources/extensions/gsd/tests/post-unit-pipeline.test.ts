/**
 * Post-unit pipeline extraction structural tests.
 *
 * These tests verify structural invariants of the extraction by inspecting the
 * actual source code of post-unit-pipeline.ts and auto.ts.
 * Full behavioral testing requires the @gsd/pi-coding-agent runtime.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pipelinePath = join(__dirname, "..", "post-unit-pipeline.ts");
const autoPath = join(__dirname, "..", "auto.ts");

const pipelineSrc = readFileSync(pipelinePath, "utf-8");
const autoSrc = readFileSync(autoPath, "utf-8");

// Extract handleAgentEnd function body from auto.ts for scoped assertions.
// handleAgentEnd has a distinctive finally block: `} finally { _handlingAgentEnd = false; }`
// We slice from its declaration to the end of that finally block.
const handleAgentEndStart = autoSrc.indexOf("export async function handleAgentEnd(");
const handleAgentEndFinallyMarker = "  } finally {\n    _handlingAgentEnd = false;\n  }\n}";
const handleAgentEndEnd = autoSrc.indexOf(handleAgentEndFinallyMarker, handleAgentEndStart);
const handleAgentEndSrc = handleAgentEndEnd > 0
  ? autoSrc.slice(handleAgentEndStart, handleAgentEndEnd + handleAgentEndFinallyMarker.length)
  : autoSrc.slice(handleAgentEndStart, autoSrc.indexOf("\nexport async function ", handleAgentEndStart + 100));

// ─── Exports ───────────────────────────────────────────────────────────────

test("pipeline: exports runPostUnitPipeline function", () => {
  assert.ok(
    pipelineSrc.includes("export async function runPostUnitPipeline("),
    "post-unit-pipeline.ts should export runPostUnitPipeline",
  );
});

test("pipeline: exports PostUnitPipelineParams interface", () => {
  assert.ok(
    pipelineSrc.includes("export interface PostUnitPipelineParams"),
    "post-unit-pipeline.ts should export PostUnitPipelineParams interface",
  );
});

test("pipeline: exports PostUnitPipelineResult interface", () => {
  assert.ok(
    pipelineSrc.includes("export interface PostUnitPipelineResult"),
    "post-unit-pipeline.ts should export PostUnitPipelineResult interface",
  );
});

// ─── Required pipeline steps in shared function ────────────────────────────

test("pipeline: contains autoCommitCurrentBranch call (commit step)", () => {
  const fnStart = pipelineSrc.indexOf("export async function runPostUnitPipeline(");
  const fnBody = pipelineSrc.slice(fnStart);
  assert.ok(
    fnBody.includes("autoCommitCurrentBranch("),
    "runPostUnitPipeline should contain autoCommitCurrentBranch( call",
  );
});

test("pipeline: contains runGSDDoctor call (doctor step)", () => {
  const fnStart = pipelineSrc.indexOf("export async function runPostUnitPipeline(");
  const fnBody = pipelineSrc.slice(fnStart);
  assert.ok(
    fnBody.includes("runGSDDoctor("),
    "runPostUnitPipeline should contain runGSDDoctor( call",
  );
});

test("pipeline: contains rebuildState call (state rebuild step)", () => {
  const fnStart = pipelineSrc.indexOf("export async function runPostUnitPipeline(");
  const fnBody = pipelineSrc.slice(fnStart);
  assert.ok(
    fnBody.includes("rebuildState("),
    "runPostUnitPipeline should contain rebuildState( call",
  );
});

test("pipeline: contains verifyExpectedArtifact call (artifact verify step)", () => {
  const fnStart = pipelineSrc.indexOf("export async function runPostUnitPipeline(");
  const fnBody = pipelineSrc.slice(fnStart);
  assert.ok(
    fnBody.includes("verifyExpectedArtifact("),
    "runPostUnitPipeline should contain verifyExpectedArtifact( call",
  );
});

test("pipeline: contains persistCompletedKey call (completion key step)", () => {
  const fnStart = pipelineSrc.indexOf("export async function runPostUnitPipeline(");
  const fnBody = pipelineSrc.slice(fnStart);
  assert.ok(
    fnBody.includes("persistCompletedKey("),
    "runPostUnitPipeline should contain persistCompletedKey( call",
  );
});

// ─── Excluded concerns — must NOT appear in shared function ────────────────

test("pipeline: does NOT contain _handlingAgentEnd (reentrancy guard stays in caller)", () => {
  const fnStart = pipelineSrc.indexOf("export async function runPostUnitPipeline(");
  const fnBody = pipelineSrc.slice(fnStart);
  assert.ok(
    !fnBody.includes("_handlingAgentEnd"),
    "runPostUnitPipeline should NOT reference _handlingAgentEnd",
  );
});

test("pipeline: does NOT contain stopAuto( (Pi-specific stop stays in caller)", () => {
  const fnStart = pipelineSrc.indexOf("export async function runPostUnitPipeline(");
  const fnBody = pipelineSrc.slice(fnStart);
  assert.ok(
    !fnBody.includes("stopAuto("),
    "runPostUnitPipeline should NOT call stopAuto()",
  );
});

test("pipeline: does NOT contain pauseAuto( (Pi-specific pause stays in caller)", () => {
  const fnStart = pipelineSrc.indexOf("export async function runPostUnitPipeline(");
  const fnBody = pipelineSrc.slice(fnStart);
  assert.ok(
    !fnBody.includes("pauseAuto("),
    "runPostUnitPipeline should NOT call pauseAuto()",
  );
});

test("pipeline: does NOT contain snapshotUnitMetrics( (metrics snapshot stays in dispatch routing)", () => {
  const fnStart = pipelineSrc.indexOf("export async function runPostUnitPipeline(");
  const fnBody = pipelineSrc.slice(fnStart);
  assert.ok(
    !fnBody.includes("snapshotUnitMetrics("),
    "runPostUnitPipeline should NOT call snapshotUnitMetrics()",
  );
});

// ─── Result interface fields ────────────────────────────────────────────────

test("pipeline: PostUnitPipelineResult contains shouldStop field", () => {
  assert.ok(
    pipelineSrc.includes("shouldStop"),
    "PostUnitPipelineResult should have shouldStop field",
  );
});

test("pipeline: PostUnitPipelineResult contains shouldPause field", () => {
  assert.ok(
    pipelineSrc.includes("shouldPause"),
    "PostUnitPipelineResult should have shouldPause field",
  );
});

test("pipeline: PostUnitPipelineResult contains pendingQuickTasksToAdd field", () => {
  assert.ok(
    pipelineSrc.includes("pendingQuickTasksToAdd"),
    "PostUnitPipelineResult should have pendingQuickTasksToAdd field",
  );
});

// ─── No direct module-state mutation ───────────────────────────────────────

test("pipeline: does NOT mutate pendingQuickTasks.push( directly (returns values instead)", () => {
  const fnStart = pipelineSrc.indexOf("export async function runPostUnitPipeline(");
  const fnBody = pipelineSrc.slice(fnStart);
  assert.ok(
    !fnBody.includes("pendingQuickTasks.push("),
    "runPostUnitPipeline should NOT push to pendingQuickTasks directly (use result.pendingQuickTasksToAdd)",
  );
});

// ─── auto.ts integration (RED until Task 2) ────────────────────────────────

test("auto.ts: handleAgentEnd calls runPostUnitPipeline(", () => {
  assert.ok(
    handleAgentEndSrc.includes("runPostUnitPipeline("),
    "handleAgentEnd should call runPostUnitPipeline()",
  );
});

test("auto.ts: handleAgentEnd does NOT contain inline autoCommitCurrentBranch( (extracted)", () => {
  // autoCommitCurrentBranch may appear in stopAuto or pauseAuto in the same file, so scope to handleAgentEnd body
  assert.ok(
    !handleAgentEndSrc.includes("autoCommitCurrentBranch("),
    "handleAgentEnd should NOT contain inline autoCommitCurrentBranch( — it's in runPostUnitPipeline",
  );
});

test("auto.ts: handleAgentEnd does NOT contain inline runGSDDoctor( (extracted)", () => {
  assert.ok(
    !handleAgentEndSrc.includes("runGSDDoctor("),
    "handleAgentEnd should NOT contain inline runGSDDoctor( — it's in runPostUnitPipeline",
  );
});

test("auto.ts: handleAgentEnd does NOT contain inline rebuildState( (extracted)", () => {
  assert.ok(
    !handleAgentEndSrc.includes("rebuildState("),
    "handleAgentEnd should NOT contain inline rebuildState( — it's in runPostUnitPipeline",
  );
});

test("auto.ts: handleAgentEnd does NOT contain inline verifyExpectedArtifact( (extracted)", () => {
  assert.ok(
    !handleAgentEndSrc.includes("verifyExpectedArtifact("),
    "handleAgentEnd should NOT contain inline verifyExpectedArtifact( — it's in runPostUnitPipeline",
  );
});

test("auto.ts: handleAgentEnd does NOT contain inline persistCompletedKey( (extracted)", () => {
  assert.ok(
    !handleAgentEndSrc.includes("persistCompletedKey("),
    "handleAgentEnd should NOT contain inline persistCompletedKey( — it's in runPostUnitPipeline",
  );
});
