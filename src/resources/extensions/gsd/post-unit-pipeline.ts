/**
 * Post-Unit Pipeline — shared completion steps for all execution paths.
 *
 * Extracted from Section 1 of handleAgentEnd() in auto.ts so that both
 * the Pi path and the future Claude Code path call the same function for
 * post-unit cleanup. Structurally prevents state corruption by making it
 * impossible for either path to omit post-unit steps.
 *
 * Steps executed (in order):
 *   1. Parallel worker signal check (returns shouldStop/shouldPause to caller)
 *   2. Cache invalidation
 *   3. 500ms file-settle delay
 *   4. Auto-commit (branch dirty files)
 *   5. Doctor + proactive health tracking (with optional LLM-assisted heal escalation)
 *   6. State rebuild + commit
 *   7. Worktree → project root state sync
 *   8. Rewrite-docs completion (resolve overrides, reset circuit breaker)
 *   9. Post-triage resolution (inject, replan, queue quick-tasks)
 *  10. Artifact verify + completion key persistence
 *
 * Excluded (caller responsibility):
 *   - clearUnitTimeout() — accesses Pi-specific timer handles
 *   - _handlingAgentEnd — reentrancy guard is caller state
 *   - stopAuto() / pauseAuto() — Pi-specific stop/pause, triggered by result fields
 *   - snapshotUnitMetrics() — belongs in dispatch routing, not pipeline
 */

import type { ExtensionContext, ExtensionAPI } from "@gsd/pi-coding-agent";
import type { CaptureEntry } from "./captures.js";
import type { TaskCommitContext } from "./git-service.js";

import { existsSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { invalidateAllCaches } from "./cache.js";
import { consumeSignal } from "./session-status-io.js";
import { autoCommitCurrentBranch } from "./worktree.js";
import { loadFile, parseSummary, resolveAllOverrides } from "./files.js";
import { resolveTaskFile } from "./paths.js";
import { runGSDDoctor, rebuildState, summarizeDoctorIssues } from "./doctor.js";
import { recordHealthSnapshot, checkHealEscalation } from "./doctor-proactive.js";
import { resetRewriteCircuitBreaker } from "./auto-dispatch.js";
import { deriveState } from "./state.js";
import { verifyExpectedArtifact, persistCompletedKey } from "./auto-recovery.js";
import { writeUnitRuntimeRecord, clearUnitRuntimeRecord } from "./unit-runtime.js";

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Sync dispatch-critical .gsd/ state files from worktree to project root.
 * Only runs when inside an auto-worktree (worktreePath differs from projectRoot).
 * Copies: STATE.md + active milestone directory (roadmap, slice plans, task summaries).
 * Non-fatal — sync failure should never block dispatch.
 *
 * Moved here from auto.ts to avoid circular imports (auto.ts imports this module).
 * The function is exported so auto.ts can remove its local copy.
 */
export function syncStateToProjectRoot(worktreePath: string, projectRoot: string, milestoneId: string | null): void {
  if (!worktreePath || !projectRoot || worktreePath === projectRoot) return;
  if (!milestoneId) return;

  const wtGsd = join(worktreePath, ".gsd");
  const prGsd = join(projectRoot, ".gsd");

  // 1. STATE.md — the quick-glance status used by initial deriveState()
  try {
    const src = join(wtGsd, "STATE.md");
    const dst = join(prGsd, "STATE.md");
    if (existsSync(src)) cpSync(src, dst, { force: true });
  } catch { /* non-fatal */ }

  // 2. Milestone directory — ROADMAP, slice PLANs, task summaries
  // Copy the entire milestone .gsd subtree so deriveState reads current checkboxes
  try {
    const srcMilestone = join(wtGsd, "milestones", milestoneId);
    const dstMilestone = join(prGsd, "milestones", milestoneId);
    if (existsSync(srcMilestone)) {
      mkdirSync(dstMilestone, { recursive: true });
      cpSync(srcMilestone, dstMilestone, { recursive: true, force: true });
    }
  } catch { /* non-fatal */ }

  // 3. Merge completed-units.json (set-union of both locations)
  // Prevents already-completed units from being re-dispatched after crash/restart.
  const srcKeysFile = join(wtGsd, "completed-units.json");
  const dstKeysFile = join(prGsd, "completed-units.json");
  if (existsSync(srcKeysFile)) {
    try {
      const srcKeys: string[] = JSON.parse(readFileSync(srcKeysFile, "utf8"));
      let dstKeys: string[] = [];
      if (existsSync(dstKeysFile)) {
        try { dstKeys = JSON.parse(readFileSync(dstKeysFile, "utf8")); } catch { /* ignore corrupt dst */ }
      }
      const merged = [...new Set([...dstKeys, ...srcKeys])];
      writeFileSync(dstKeysFile, JSON.stringify(merged, null, 2));
    } catch { /* non-fatal */ }
  }

  // 4. Runtime records — unit dispatch state used by selfHealRuntimeRecords().
  // Without this, a crash during a unit leaves the runtime record only in the
  // worktree. If the next session resolves basePath before worktree re-entry,
  // selfHeal can't find or clear the stale record (#769).
  try {
    const srcRuntime = join(wtGsd, "runtime", "units");
    const dstRuntime = join(prGsd, "runtime", "units");
    if (existsSync(srcRuntime)) {
      mkdirSync(dstRuntime, { recursive: true });
      cpSync(srcRuntime, dstRuntime, { recursive: true, force: true });
    }
  } catch { /* non-fatal */ }
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * All state required by the post-unit pipeline.
 * Explicit parameters — no closure over auto.ts module variables.
 */
export interface PostUnitPipelineParams {
  ctx: ExtensionContext;
  /** Optional Pi API handle — used for LLM-assisted doctor heal escalation (Pi-specific).
   *  Phase 3 Claude Code path will omit this; escalation is skipped when absent. */
  pi?: ExtensionAPI;
  basePath: string;
  originalBasePath: string;
  currentMilestoneId: string | null;
  currentUnit: { type: string; id: string; startedAt: number };
  completedKeySet: Set<string>;
  lastPromptCharCount: number | undefined;
  lastBaselineCharCount: number | undefined;
  currentUnitRouting: { tier: string; modelDowngraded: boolean } | null;
}

/**
 * Values returned by the pipeline for the caller to act on.
 * Returned instead of mutating auto.ts module state.
 */
export interface PostUnitPipelineResult {
  /** Caller should call stopAuto() and return if true. */
  shouldStop: boolean;
  /** Caller should call pauseAuto() and return if true. */
  shouldPause: boolean;
  /** Whether the trigger unit's expected artifact was verified as present. */
  triggerArtifactVerified: boolean;
  /** Whether a new completion key was persisted during this pipeline run. */
  completedKeyAdded: boolean;
  /** Quick-tasks queued by triage resolution — caller pushes to pendingQuickTasks. */
  pendingQuickTasksToAdd: CaptureEntry[];
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * Run all post-unit completion steps.
 *
 * Called by handleAgentEnd() immediately after clearUnitTimeout().
 * Returns a result object the caller uses to apply Pi-specific side effects.
 */
export async function runPostUnitPipeline(
  params: PostUnitPipelineParams,
): Promise<PostUnitPipelineResult> {
  const {
    ctx,
    pi,
    basePath,
    originalBasePath,
    currentMilestoneId,
    currentUnit,
    completedKeySet,
  } = params;

  const result: PostUnitPipelineResult = {
    shouldStop: false,
    shouldPause: false,
    triggerArtifactVerified: false,
    completedKeyAdded: false,
    pendingQuickTasksToAdd: [],
  };

  // ── Step 1: Parallel worker signal check ──────────────────────────────────
  // When running as a parallel worker (GSD_MILESTONE_LOCK set), check for
  // coordinator signals before proceeding with post-unit steps.
  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
  if (milestoneLock) {
    const signal = consumeSignal(basePath, milestoneLock);
    if (signal) {
      if (signal.signal === "stop") {
        result.shouldStop = true;
        return result;
      }
      if (signal.signal === "pause") {
        result.shouldPause = true;
        return result;
      }
      // "resume" and "rebase" signals are handled elsewhere or no-op here
    }
  }

  // ── Step 2: Cache invalidation ────────────────────────────────────────────
  // The unit just completed and may have written planning files (task summaries,
  // roadmap checkboxes, etc.)
  invalidateAllCaches();

  // ── Step 3: File-settle delay ─────────────────────────────────────────────
  await new Promise(r => setTimeout(r, 500));

  // ── Step 4: Auto-commit ───────────────────────────────────────────────────
  // Commit any dirty files the LLM left behind on the current branch.
  // For execute-task units, build a meaningful commit message from the
  // task summary (one-liner, key_files, inferred type). For other unit
  // types, fall back to the generic chore() message.
  try {
    let taskContext: TaskCommitContext | undefined;

    if (currentUnit.type === "execute-task") {
      const parts = currentUnit.id.split("/");
      const [mid, sid, tid] = parts;
      if (mid && sid && tid) {
        const summaryPath = resolveTaskFile(basePath, mid, sid, tid, "SUMMARY");
        if (summaryPath) {
          try {
            const summaryContent = await loadFile(summaryPath);
            if (summaryContent) {
              const summary = parseSummary(summaryContent);
              taskContext = {
                taskId: `${sid}/${tid}`,
                taskTitle: summary.title?.replace(/^T\d+:\s*/, "") || tid,
                oneLiner: summary.oneLiner || undefined,
                keyFiles: summary.frontmatter.key_files?.filter(f => !f.includes("{{")) || undefined,
              };
            }
          } catch {
            // Non-fatal — fall back to generic message
          }
        }
      }
    }

    const commitMsg = autoCommitCurrentBranch(basePath, currentUnit.type, currentUnit.id, taskContext);
    if (commitMsg) {
      ctx.ui.notify(`Committed: ${commitMsg.split("\n")[0]}`, "info");
    }
  } catch {
    // Non-fatal
  }

  // ── Step 5: Doctor + proactive health tracking ────────────────────────────
  // Post-hook: fix mechanical bookkeeping the LLM may have skipped.
  // 1. Doctor handles: checkbox marking (task-level bookkeeping).
  // 2. STATE.md is always rebuilt from disk state (purely derived, no LLM needed).
  // fixLevel:"task" ensures doctor only fixes task-level issues (e.g. marking
  // checkboxes). Slice/milestone completion transitions (summary stubs,
  // roadmap [x] marking) are left for the complete-slice dispatch unit.
  try {
    const scopeParts = currentUnit.id.split("/").slice(0, 2);
    const doctorScope = scopeParts.join("/");
    const report = await runGSDDoctor(basePath, { fix: true, scope: doctorScope, fixLevel: "task" });
    if (report.fixesApplied.length > 0) {
      ctx.ui.notify(`Post-hook: applied ${report.fixesApplied.length} fix(es).`, "info");
    }

    // Record health snapshot for trend analysis and escalation logic.
    const doctorSummary = summarizeDoctorIssues(report.issues);
    recordHealthSnapshot(doctorSummary.errors, doctorSummary.warnings, report.fixesApplied.length);

    // Check if we should escalate to LLM-assisted heal
    if (doctorSummary.errors > 0) {
      const unresolvedErrors = report.issues
        .filter(i => i.severity === "error" && !i.fixable)
        .map(i => ({ code: i.code, message: i.message, unitId: i.unitId }));
      const escalation = checkHealEscalation(doctorSummary.errors, unresolvedErrors);
      if (escalation.shouldEscalate) {
        ctx.ui.notify(
          `Doctor heal escalation: ${escalation.reason}. Dispatching LLM-assisted heal.`,
          "warning",
        );
        // dispatchDoctorHeal requires the Pi API — only available on the Pi path.
        if (pi) {
          try {
            const { formatDoctorIssuesForPrompt, formatDoctorReport } = await import("./doctor.js");
            const { dispatchDoctorHeal } = await import("./commands.js");
            const actionable = report.issues.filter(i => i.severity === "error");
            const reportText = formatDoctorReport(report, { scope: doctorScope, includeWarnings: true });
            const structuredIssues = formatDoctorIssuesForPrompt(actionable);
            dispatchDoctorHeal(pi, doctorScope, reportText, structuredIssues);
          } catch {
            // Non-fatal — escalation dispatch failure
          }
        }
      }
    }
  } catch {
    // Non-fatal — doctor failure should never block dispatch
  }

  // ── Step 6: State rebuild + commit ────────────────────────────────────────
  try {
    await rebuildState(basePath);
    // State rebuild commit is bookkeeping — generic message is appropriate
    autoCommitCurrentBranch(basePath, "state-rebuild", currentUnit.id);
  } catch {
    // Non-fatal
  }

  // ── Step 7: Worktree → project root state sync ────────────────────────────
  // Ensures that if auto-mode restarts, deriveState(projectRoot) reads
  // current milestone progress instead of stale pre-worktree state (#654).
  if (originalBasePath && originalBasePath !== basePath) {
    try {
      syncStateToProjectRoot(basePath, originalBasePath, currentMilestoneId);
    } catch {
      // Non-fatal — stale state is the existing behavior, sync is an improvement
    }
  }

  // ── Step 8: Rewrite-docs completion ───────────────────────────────────────
  if (currentUnit.type === "rewrite-docs") {
    try {
      await resolveAllOverrides(basePath);
      resetRewriteCircuitBreaker();
      ctx.ui.notify("Override(s) resolved — rewrite-docs completed.", "info");
    } catch {
      // Non-fatal — verifyExpectedArtifact will catch unresolved overrides
    }
  }

  // ── Step 9: Post-triage resolution ── Post-triage: execute actionable resolutions ──
  // After a triage-captures unit completes, the LLM has classified captures and
  // updated CAPTURES.md. Now we execute those classifications: inject tasks into
  // the plan, write replan triggers, and queue quick-tasks for dispatch.
  if (currentUnit.type === "triage-captures") {
    try {
      const { executeTriageResolutions } = await import("./triage-resolution.js");
      const state = await deriveState(basePath);
      const mid = state.activeMilestone?.id;
      const sid = state.activeSlice?.id;

      if (mid && sid) {
        const triageResult = executeTriageResolutions(basePath, mid, sid);

        if (triageResult.injected > 0) {
          ctx.ui.notify(
            `Triage: injected ${triageResult.injected} task${triageResult.injected === 1 ? "" : "s"} into ${sid} plan.`,
            "info",
          );
        }
        if (triageResult.replanned > 0) {
          ctx.ui.notify(
            `Triage: replan trigger written for ${sid} — next dispatch will enter replanning.`,
            "info",
          );
        }
        if (triageResult.quickTasks.length > 0) {
          // Collect quick-tasks into result — caller pushes to pendingQuickTasks.
          for (const qt of triageResult.quickTasks) {
            result.pendingQuickTasksToAdd.push(qt);
          }
          ctx.ui.notify(
            `Triage: ${triageResult.quickTasks.length} quick-task${triageResult.quickTasks.length === 1 ? "" : "s"} queued for execution.`,
            "info",
          );
        }
        for (const action of triageResult.actions) {
          process.stderr.write(`gsd-triage: ${action}\n`);
        }
      }
    } catch (err) {
      // Non-fatal — triage resolution failure shouldn't block dispatch
      process.stderr.write(`gsd-triage: resolution execution failed: ${(err as Error).message}\n`);
    }
  }

  // ── Step 10: Artifact verify + completion key persistence ── Path A fix: verify artifact ──
  // After doctor + rebuildState, check whether the just-completed unit actually
  // produced its expected artifact. If so, persist the completion key now so the
  // idempotency check at the top of dispatchNextUnit() skips it — even if
  // deriveState() still returns this unit as active (e.g. branch mismatch).
  //
  // IMPORTANT: For non-hook units, defer persistence until after the hook check.
  // If a post-unit hook requests a retry, we need to remove the completion key
  // so dispatchNextUnit re-dispatches the trigger unit.
  if (!currentUnit.type.startsWith("hook/")) {
    try {
      result.triggerArtifactVerified = verifyExpectedArtifact(currentUnit.type, currentUnit.id, basePath);
      if (result.triggerArtifactVerified) {
        const completionKey = `${currentUnit.type}/${currentUnit.id}`;
        if (!completedKeySet.has(completionKey)) {
          persistCompletedKey(basePath, completionKey);
          completedKeySet.add(completionKey);
          result.completedKeyAdded = true;
        }
        invalidateAllCaches();
      }
    } catch {
      // Non-fatal — worst case we fall through to normal dispatch which has its own checks
    }
  } else {
    // Hook unit completed — finalize its runtime record and clear it
    try {
      writeUnitRuntimeRecord(basePath, currentUnit.type, currentUnit.id, currentUnit.startedAt, {
        phase: "finalized",
        progressCount: 1,
        lastProgressKind: "hook-completed",
      });
      clearUnitRuntimeRecord(basePath, currentUnit.type, currentUnit.id);
    } catch {
      // Non-fatal
    }
  }

  return result;
}
