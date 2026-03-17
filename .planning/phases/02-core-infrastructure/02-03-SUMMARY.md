---
phase: 02-core-infrastructure
plan: "03"
subsystem: infra
tags: [claude-agent-sdk, typebox, zod, mcp, sdk-integration]

requires:
  - phase: 02-core-infrastructure/02-02
    provides: models-resolver.ts with tier mapping patterns (TDD pattern reference)

provides:
  - "typeboxToZodShape(): converts TObject to raw Zod shape using schema.required array for optionality"
  - "wrapPromptAsAsyncIterable(): AsyncGenerator yielding single SDKUserMessage for SDK query() input"
  - "createGsdMcpServer(): dynamically imports SDK, creates in-process MCP server with 3 GSD tools"
  - "mcp-tools.test.ts: 12 tests covering all 3 tool schemas, required/optional detection, description preservation, prompt wrapper"

affects: [02-core-infrastructure, sdk-executor, claude-code-provider, Phase3]

tech-stack:
  added: []
  patterns:
    - "TypeBox-to-Zod conversion using schema.required array (not Symbol check) for reliable optionality detection"
    - "Dynamic SDK import with clear error message for optional dependency pattern"
    - "Raw Zod shape (Record<string, z.ZodTypeAny>) vs z.ZodObject for SDK tool() compatibility"
    - "TypeBox schema constants mirroring index.ts definitions — single source of truth preserved"

key-files:
  created:
    - "src/resources/extensions/gsd/claude-code/mcp-tools.ts"
    - "src/resources/extensions/gsd/tests/mcp-tools.test.ts"
  modified: []

key-decisions:
  - "typeboxToZodShape returns raw shape Record<string, z.ZodTypeAny>, not z.ZodObject — SDK tool() expects AnyZodRawShape directly"
  - "Optionality detected via schema.required array absence, not TypeBox Symbol marker — more robust and follows JSON Schema spec"
  - "SDK import wrapped in try/catch with install instructions — optional dependency fails at call time, not module load time"
  - "TypeBox schema constants duplicated in mcp-tools.ts as exact mirrors of index.ts — cleanest approach given schemas are not exported from index.ts"

patterns-established:
  - "Pattern: Dynamic optional SDK import — all SDK consumers use try/catch import with clear error + install instructions"
  - "Pattern: TypeBox-to-Zod shape conversion — typeboxToZodShape() is the canonical converter for all 3 GSD tool schemas"
  - "Pattern: AsyncIterable prompt wrapper — wrapPromptAsAsyncIterable() required when using MCP tools with query()"

requirements-completed: [TOOL-01, TOOL-02]

duration: 6min
completed: 2026-03-18
---

# Phase 02 Plan 03: MCP Tools Summary

**TypeBox-to-Zod converter + SDK MCP server with 3 GSD tools using schema.required array for optionality and dynamic SDK import**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-17T18:47:39Z
- **Completed:** 2026-03-17T18:53:39Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 2

## Accomplishments

- `typeboxToZodShape()` converts TObject to raw Zod shape preserving descriptions and required/optional semantics using the `schema.required` array — not the fragile TypeBox Symbol approach
- `wrapPromptAsAsyncIterable()` yields a single `{ role: "user", content: string }` message required for MCP tool-enabled query() calls
- `createGsdMcpServer()` dynamically imports the SDK (optional dependency), converts the 3 TypeBox schemas to Zod shapes, and registers gsd_save_decision, gsd_update_requirement, gsd_save_summary via `createSdkMcpServer()`
- 12 tests verify all 3 tool schemas produce correct required/optional field counts, descriptions are preserved, and the prompt wrapper yields the correct message shape

## Task Commits

1. **Task 1 RED: Failing tests** - `c44c712` (test)
2. **Task 1 GREEN: mcp-tools.ts implementation** - `79e9527` (feat, included in docs(02-02) docs commit)

## Files Created/Modified

- `src/resources/extensions/gsd/claude-code/mcp-tools.ts` — TypeBox-to-Zod converter, AsyncIterable prompt wrapper, and createGsdMcpServer() with 3 registered tools
- `src/resources/extensions/gsd/tests/mcp-tools.test.ts` — 12 tests covering schema conversion, required/optional detection, description preservation, prompt wrapper shape

## Decisions Made

- Used `schema.required` array absence for optionality detection per RESEARCH.md Pitfall 1 recommendation — TypeBox `Symbol.for("TypeBox.Optional")` check is fragile and unreliable
- `typeboxToZodShape()` returns `Record<string, z.ZodTypeAny>` (raw shape), not `z.ZodObject` — the SDK's `tool()` function expects `AnyZodRawShape` directly
- TypeBox schema constants in mcp-tools.ts are exact mirrors of index.ts definitions — the cleanest approach since the schemas are not exported from index.ts as standalone constants
- SDK import wrapped in try/catch with descriptive error message including exact install command

## Deviations from Plan

None — plan executed exactly as written. The mcp-tools.ts and test file were partially created in the prior session (79e9527) and tests already passing on plan resumption.

## Issues Encountered

- 5 pre-existing test failures in the full unit suite (mcp-server.test.ts requires built dist artifact; worktree-e2e.test.ts and getRepoInfo require live GitHub API) — confirmed pre-existing before this plan's changes, out of scope

## Next Phase Readiness

- mcp-tools.ts is ready for use by the Phase 3 sdk-executor — `createGsdMcpServer()` is the entry point, `wrapPromptAsAsyncIterable()` is the prompt wrapper
- provider-routing.ts (02-01), models-resolver.ts (02-02), mcp-tools.ts (02-03), hook-bridge.ts (02-04), activity-writer.ts (02-05) form the complete Phase 2 leaf-node module set
- auth-storage.ts claude-code credential extension (02-01) still has uncommitted changes in working tree — needs 02-01 re-run

---
*Phase: 02-core-infrastructure*
*Completed: 2026-03-18*
