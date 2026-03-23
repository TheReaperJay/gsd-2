---
estimated_steps: 4
estimated_files: 7
skills_used: []
---

# T03: Migrate warm/cold callers batch 1 — doctor, visualizer, workspace, dashboard, guided-flow

**Slice:** S05 — Warm/cold callers + flag files + pre-M002 migration
**Milestone:** M001

## Description

Apply the established S04 migration pattern (`isDbAvailable()` gate + lazy `createRequire` fallback) to 7 warm/cold caller files: `doctor.ts`, `doctor-checks.ts`, `visualizer-data.ts`, `workspace-index.ts`, `dashboard-overlay.ts`, `auto-dashboard.ts`, `guided-flow.ts`. These files have straightforward parseRoadmap/parsePlan usage that can be mechanically replaced with DB queries.

**Pattern reference (from S04 dispatch-guard.ts):**
```typescript
// Remove from module-level import:
// import { parseRoadmap } from "./files.js";

// Add to module-level import:
import { isDbAvailable, getMilestoneSlices } from "./gsd-db.js";

// At each call site, replace:
//   const roadmap = parseRoadmap(content);
//   for (const slice of roadmap.slices) { ... }
// With:
if (isDbAvailable()) {
  const slices = getMilestoneSlices(mid);
  // use slices directly — SliceRow has .id, .title, .status, .risk, .depends, .demo
  // .done equivalent: slice.status === 'complete'
} else {
  // Lazy fallback
  const { createRequire } = await import("node:module");
  const _require = createRequire(import.meta.url);
  let parseRoadmap: (c: string) => { slices: Array<{ id: string; done: boolean; title: string; risk: string; depends: string[]; demo: string }> };
  try {
    parseRoadmap = _require("./files.ts").parseRoadmap;
  } catch {
    parseRoadmap = _require("./files.js").parseRoadmap;
  }
  const roadmap = parseRoadmap(content);
  // ... use roadmap.slices
}
```

**Key mapping from parsed types to DB types:**
- `roadmap.slices[].done` → `slice.status === 'complete'`
- `roadmap.slices[].id/title/risk/depends/demo` → same field names on `SliceRow`
- `plan.tasks[].done` → `task.status === 'complete' || task.status === 'done'`
- `plan.tasks[].id/title` → same on `TaskRow`
- `plan.tasks[].files` → `task.files` (already parsed as `string[]` by `rowToTask()`)
- `plan.tasks[].verify` → `task.verify`
- `plan.filesLikelyTouched` → aggregate: `sliceTasks.flatMap(t => t.files)`

**Important:** Some of these files have async functions (doctor.ts, visualizer-data.ts, workspace-index.ts, dashboard-overlay.ts, auto-dashboard.ts). For async callers, `await import("./gsd-db.js")` is cleaner than `createRequire`. For synchronous callers, use `createRequire`. Check each file.

## Steps

1. **doctor.ts** (3 parseRoadmap + 1 parsePlan):
   - Remove `parseRoadmap`, `parsePlan` from the module-level import from `./files.js`. Keep `loadFile`, `parseSummary`, `saveFile`, `parseTaskPlanMustHaves`, `countMustHavesMentionedInSummary`.
   - Add `import { isDbAvailable, getMilestoneSlices, getSliceTasks } from "./gsd-db.js";`
   - At line ~216: replace `parseRoadmap(roadmapContent).slices` with `isDbAvailable() ? getMilestoneSlices(mid) : lazyParseRoadmap(roadmapContent).slices`. Map `.done` to `.status === 'complete'`.
   - At line ~463: same pattern.
   - At line ~582: replace `parsePlan(planContent)` with `isDbAvailable() ? { tasks: getSliceTasks(mid, sid) } : lazyParsePlan(planContent)`. Map task fields accordingly.
   - Create a local lazy-parser helper function at the top of the file to avoid repeating the createRequire boilerplate.

2. **doctor-checks.ts** (2 parseRoadmap):
   - Remove `parseRoadmap` from import. Keep `loadFile`.
   - Add DB imports. Replace 2 call sites with `getMilestoneSlices()` + fallback.

3. **visualizer-data.ts** (1 parseRoadmap + 1 parsePlan):
   - Remove parser imports. Add DB imports. Replace call sites.

4. **workspace-index.ts** (2 parseRoadmap + 1 parsePlan):
   - Remove parser imports. Add DB imports. Replace 3 call sites.

5. **dashboard-overlay.ts** (1 parseRoadmap + 1 parsePlan):
   - Remove parser imports. Add DB imports. Replace call sites.

6. **auto-dashboard.ts** (1 parseRoadmap + 1 parsePlan):
   - Remove parser imports. Add DB imports. Replace call sites.

7. **guided-flow.ts** (2 parseRoadmap):
   - Remove `parseRoadmap` from import. Keep `loadFile`. Add DB imports. Replace 2 call sites.

After all changes, run verification grep and existing test suites.

## Must-Haves

- [ ] Zero module-level `parseRoadmap`/`parsePlan` imports in all 7 files
- [ ] Each file uses `isDbAvailable()` gate with DB query as primary path
- [ ] Each file has lazy `createRequire` (or dynamic import for async) fallback for parser
- [ ] `SliceRow.status === 'complete'` used instead of `.done` for all DB-path code
- [ ] Existing tests pass for all modified files

## Verification

- `grep -n 'import.*parseRoadmap\|import.*parsePlan' src/resources/extensions/gsd/doctor.ts src/resources/extensions/gsd/doctor-checks.ts src/resources/extensions/gsd/visualizer-data.ts src/resources/extensions/gsd/workspace-index.ts src/resources/extensions/gsd/dashboard-overlay.ts src/resources/extensions/gsd/auto-dashboard.ts src/resources/extensions/gsd/guided-flow.ts` — returns zero results
- Run available test suites: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/doctor.test.ts`
- Run `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-dashboard.test.ts` (if exists)

## Inputs

- `src/resources/extensions/gsd/doctor.ts` — 3 parseRoadmap + 1 parsePlan calls to migrate
- `src/resources/extensions/gsd/doctor-checks.ts` — 2 parseRoadmap calls
- `src/resources/extensions/gsd/visualizer-data.ts` — 1 parseRoadmap + 1 parsePlan
- `src/resources/extensions/gsd/workspace-index.ts` — 2 parseRoadmap + 1 parsePlan
- `src/resources/extensions/gsd/dashboard-overlay.ts` — 1 parseRoadmap + 1 parsePlan
- `src/resources/extensions/gsd/auto-dashboard.ts` — 1 parseRoadmap + 1 parsePlan
- `src/resources/extensions/gsd/guided-flow.ts` — 2 parseRoadmap
- `src/resources/extensions/gsd/gsd-db.ts` — isDbAvailable(), getMilestoneSlices(), getSliceTasks(), SliceRow, TaskRow interfaces
- `src/resources/extensions/gsd/dispatch-guard.ts` — reference implementation of the migration pattern from S04

## Expected Output

- `src/resources/extensions/gsd/doctor.ts` — module-level parser imports removed, DB queries + lazy fallback
- `src/resources/extensions/gsd/doctor-checks.ts` — same migration
- `src/resources/extensions/gsd/visualizer-data.ts` — same migration
- `src/resources/extensions/gsd/workspace-index.ts` — same migration
- `src/resources/extensions/gsd/dashboard-overlay.ts` — same migration
- `src/resources/extensions/gsd/auto-dashboard.ts` — same migration
- `src/resources/extensions/gsd/guided-flow.ts` — same migration

## Observability Impact

- **Signal change:** All 7 migrated files now use `isDbAvailable()` as primary data path. When DB is available, these callers read slice/task data from SQLite instead of parsing markdown. The lazy `createRequire` fallback logs to stderr when it activates, making parser-path usage detectable in logs.
- **Inspection:** `grep -rn 'isDbAvailable' src/resources/extensions/gsd/{doctor,doctor-checks,visualizer-data,workspace-index,dashboard-overlay,auto-dashboard,guided-flow}.ts` shows all gate points. At runtime, DB availability determines which path executes.
- **Failure visibility:** If DB is unavailable, fallback to parser is silent but functional. If parser also fails, existing error handling in each function propagates the failure (most are wrapped in try/catch with non-fatal fallthrough).
