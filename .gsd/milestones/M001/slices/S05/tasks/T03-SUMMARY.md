---
id: T03
parent: S05
milestone: M001
key_files:
  - src/resources/extensions/gsd/doctor.ts
  - src/resources/extensions/gsd/doctor-checks.ts
  - src/resources/extensions/gsd/visualizer-data.ts
  - src/resources/extensions/gsd/workspace-index.ts
  - src/resources/extensions/gsd/dashboard-overlay.ts
  - src/resources/extensions/gsd/auto-dashboard.ts
  - src/resources/extensions/gsd/guided-flow.ts
key_decisions:
  - All 7 files use file-local lazy parser singletons via createRequire rather than a shared utility — consistent with dispatch-guard.ts reference pattern and avoids introducing a new shared module
  - workspace-index.ts titleFromRoadmapHeader kept as lazy-parser-only (no DB path) because it extracts title from raw markdown header which has no direct DB equivalent for the formatted title string
duration: ""
verification_result: passed
completed_at: 2026-03-23T18:06:03.490Z
blocker_discovered: false
---

# T03: Migrate 7 warm/cold callers (doctor, doctor-checks, visualizer-data, workspace-index, dashboard-overlay, auto-dashboard, guided-flow) from module-level parseRoadmap/parsePlan imports to isDbAvailable() gate + lazy createRequire fallback

**Migrate 7 warm/cold callers (doctor, doctor-checks, visualizer-data, workspace-index, dashboard-overlay, auto-dashboard, guided-flow) from module-level parseRoadmap/parsePlan imports to isDbAvailable() gate + lazy createRequire fallback**

## What Happened

Applied the established S04 migration pattern to all 7 target files. Each file had its module-level `parseRoadmap` and/or `parsePlan` imports removed from `./files.js` and replaced with:

1. **DB imports:** `isDbAvailable`, `getMilestoneSlices`, `getSliceTasks` from `./gsd-db.js`
2. **Lazy parser helper:** A file-local `getLazyParsers()` (or `lazyParseRoadmap()`) function using `createRequire(import.meta.url)` to resolve `./files.ts` then `./files.js` on demand
3. **isDbAvailable() gate** at each call site: DB path uses `getMilestoneSlices()`/`getSliceTasks()` with `status === "complete"` mapped to `.done`; else-branch uses the lazy parser

**File-by-file details:**

- **doctor.ts** (3 parseRoadmap + 1 parsePlan): First call site in `selectDoctorScope()` inlines DB completion check. Second call site in `runDoctor()` normalizes slices into `NormSlice[]` compatible with `detectCircularDependencies` and downstream iteration. Third call site for `parsePlan` normalizes tasks from DB or parser. Replaced `isMilestoneComplete(roadmap)` at end-of-function with inline `roadmap.slices.every(s => s.done)` check since the local `roadmap` object only has `{ slices }`.

- **doctor-checks.ts** (2 parseRoadmap): Both in `checkGitHealth()` for milestone completion checks (orphaned worktrees, stale branches). Each wrapped with `isDbAvailable()` gate — DB path counts complete slices directly.

- **visualizer-data.ts** (1 parseRoadmap + 1 parsePlan): `loadVisualizerData()` now builds normalized slice list from DB or parser, then normalizes tasks for active slices similarly.

- **workspace-index.ts** (2 parseRoadmap + 1 parsePlan): `titleFromRoadmapHeader()` uses lazy parser (sync helper, only called from async context). `indexSlice()` gets tasks from DB or parser. `indexWorkspace()` gets slices from DB or parser.

- **dashboard-overlay.ts** (1 parseRoadmap + 1 parsePlan): `loadData()` builds normalized slice/task lists from DB or parser.

- **auto-dashboard.ts** (1 parseRoadmap + 1 parsePlan): `updateSliceProgressCache()` is synchronous — uses `createRequire` for fallback. Both parseRoadmap and parsePlan replaced with DB primary paths.

- **guided-flow.ts** (2 parseRoadmap): `buildDiscussSlicePrompt()` and `showDiscuss()` both normalize slices from DB or parser. The `showDiscuss()` guard was adjusted to allow DB-backed operation even when roadmap file is missing.

## Verification

All 5 must-haves verified:
1. Zero module-level parseRoadmap/parsePlan imports in all 7 files — confirmed by grep returning exit code 1 (no matches)
2. Each file uses isDbAvailable() gate — confirmed 2-3 gates per file
3. Each file has lazy createRequire fallback — confirmed 2 createRequire refs per file (1 import, 1 usage)
4. SliceRow.status === 'complete' used instead of .done for all DB-path code — confirmed in all files
5. All existing tests pass: doctor.test.ts (55 pass), auto-dashboard.test.ts (24 pass), auto-recovery.test.ts (33 pass), derive-state-db.test.ts (105 pass), derive-state-crossval.test.ts (189 pass), planning-crossval.test.ts (65 pass), markdown-renderer.test.ts (106 pass), flag-file-db.test.ts (14 pass), gsd-recover.test.ts (65 pass) — all zero failures

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `grep -n 'import.*parseRoadmap\|import.*parsePlan' src/resources/extensions/gsd/doctor.ts src/resources/extensions/gsd/doctor-checks.ts src/resources/extensions/gsd/visualizer-data.ts src/resources/extensions/gsd/workspace-index.ts src/resources/extensions/gsd/dashboard-overlay.ts src/resources/extensions/gsd/auto-dashboard.ts src/resources/extensions/gsd/guided-flow.ts` | 1 | ✅ pass | 50ms |
| 2 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/doctor.test.ts` | 0 | ✅ pass | 6900ms |
| 3 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-dashboard.test.ts` | 0 | ✅ pass | 6900ms |
| 4 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-recovery.test.ts` | 0 | ✅ pass | 6700ms |
| 5 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/derive-state-db.test.ts` | 0 | ✅ pass | 6700ms |
| 6 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/derive-state-crossval.test.ts` | 0 | ✅ pass | 6700ms |
| 7 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/planning-crossval.test.ts` | 0 | ✅ pass | 6700ms |
| 8 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/markdown-renderer.test.ts` | 0 | ✅ pass | 6700ms |
| 9 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/flag-file-db.test.ts` | 0 | ✅ pass | 6700ms |
| 10 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-recover.test.ts` | 0 | ✅ pass | 6700ms |


## Deviations

In doctor.ts, replaced `isMilestoneComplete(roadmap)` calls at end-of-function with inline `roadmap.slices.every(s => s.done)` check because the local `roadmap` object was normalized to `{ slices: NormSlice[] }` which doesn't satisfy the full `Roadmap` type signature. The logic is identical. In guided-flow.ts showDiscuss(), adjusted the early return guard from `if (!roadmapContent)` to `if (!roadmapContent && !isDbAvailable())` so the DB path can function even without a roadmap file on disk.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/doctor.ts`
- `src/resources/extensions/gsd/doctor-checks.ts`
- `src/resources/extensions/gsd/visualizer-data.ts`
- `src/resources/extensions/gsd/workspace-index.ts`
- `src/resources/extensions/gsd/dashboard-overlay.ts`
- `src/resources/extensions/gsd/auto-dashboard.ts`
- `src/resources/extensions/gsd/guided-flow.ts`
