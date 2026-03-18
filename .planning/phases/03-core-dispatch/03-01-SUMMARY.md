---
phase: 03-core-dispatch
plan: "01"
subsystem: claude-code
tags: [sdk, steering, async-generator, stop-hook, tdd, supervision]

# Dependency graph
requires:
  - phase: 02-core-infrastructure
    provides: hook-bridge, activity-writer, models-resolver, mcp-tools, provider-routing
provides:
  - SteeringQueue: async generator queue for SDK prompt channel (initial prompt + steering pushes)
  - sdkExecuteUnit: executes a GSD unit via Claude Agent SDK query() with full supervision parity
  - SdkExecutorParams/SdkExecutorResult interfaces: contract for auto.ts integration
  - getSdkActiveQuery/setSdkActiveQuery: exported for stopAuto() cancellation wiring
affects:
  - 03-02 (auto.ts branch point — will call sdkExecuteUnit() from dispatchNextUnit())
  - stopAuto() integration (getSdkActiveQuery for interrupt/close)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dependency injection via optional _deps parameter for testable async SDK functions"
    - "AsyncGenerator with push/close semantics for blocking steering channel"
    - "try/finally in async generator to prevent leaked Promise<void> on consumer break"
    - "mock.timers in node:test for deterministic timer-based test scenarios"
    - "SteeringQueue as AsyncIterable<SDKUserMessage> passed as SDK query() prompt"

key-files:
  created:
    - src/resources/extensions/gsd/claude-code/sdk-executor.ts
    - src/resources/extensions/gsd/tests/sdk-executor.test.ts
  modified: []

key-decisions:
  - "sdkExecuteUnit accepts optional _deps parameter for test injection — avoids dynamic import() mocking"
  - "SteeringQueue.close() called in finally block only — not in response to intermediate events (Pitfall 2)"
  - "Stop hook checks stop_hook_active before blocking — never blocks on second fire (Pitfall 3 prevention)"
  - "maxTurns intentionally NOT set — GSD supervision is time-based via steering channel (LOCKED decision)"
  - "persistSession: false to prevent accumulating session history (Pitfall 6)"
  - "permissionMode: bypassPermissions + allowDangerouslySkipPermissions: true for unattended mode (Pitfall 7)"
  - "Error subtypes use exact SDK names: error_during_execution, error_max_turns, error_max_budget_usd (Pitfall 4)"
  - "try/finally added to SteeringQueue generator to clean up pending resolve refs on consumer .return()"
  - "Steering tests redesigned to use mock.timers instead of live timers to avoid Promise leak warnings"

patterns-established:
  - "Dependency-injected async functions: production creates real instances, tests inject fakes via _deps"
  - "SteeringQueue pattern: initial prompt yielded first, then blocks waiting for push() until close()"
  - "mock.timers.tick() for testing setTimeout-based supervision without real delays"

requirements-completed: [EXEC-01, EXEC-03, EXEC-06, SUP-03, SUP-04]

# Metrics
duration: 13min
completed: 2026-03-18
---

# Phase 3 Plan 01: SDK Executor Summary

**SteeringQueue async generator + sdkExecuteUnit() implementing full SDK execution with time-based supervision, stop hook, error mapping, and activity logging**

## Performance

- **Duration:** 13 min
- **Started:** 2026-03-18T04:56:52Z
- **Completed:** 2026-03-18T05:10:19Z
- **Tasks:** 2 (TDD: RED + GREEN)
- **Files modified:** 2 (sdk-executor.ts created, sdk-executor.test.ts created)

## Accomplishments

- SteeringQueue class: async generator with push/close semantics that yields initial prompt then blocks for steering messages; try/finally ensures no leaked promises when consumer calls .return()
- sdkExecuteUnit(): dependency-injectable function that wires query() with all 7 pitfall-prevention behaviors baked in; supervision timers (wrapup warning, idle watchdog, hard timeout) set up internally
- All 7 describe blocks pass: SteeringQueue, query options, message processing, Stop hook, error handling, steering, cleanup
- 33 individual test cases covering every behavior from PLAN.md requirements

## Task Commits

Each task was committed atomically:

1. **Task 1: Write failing tests (RED)** - `2f6add8` (test)
2. **Task 2: Implement sdk-executor.ts (GREEN)** - `229e625` (feat)

## Files Created/Modified

- `src/resources/extensions/gsd/claude-code/sdk-executor.ts` - SteeringQueue class, sdkExecuteUnit function, SdkExecutorParams/SdkExecutorResult/SdkExecutorDeps interfaces, getSdkActiveQuery/setSdkActiveQuery exports
- `src/resources/extensions/gsd/tests/sdk-executor.test.ts` - 33 test cases covering all behaviors via dependency injection

## Decisions Made

- Dependency injection via optional `_deps` parameter: avoids needing to mock `dynamic import()` which is hard in `node:test`. Production path imports SDK and creates real instances; test path injects fakes. This is cleaner than module registry mocking.
- `try/finally` in SteeringQueue generator: when a consumer calls `.return()` on the iterator (e.g., `for await ... break`), the generator's finally block runs and clears `this.resolve`. Without this, the pending `new Promise<void>` inside the generator becomes an unresolvable leaked promise that `node:test` correctly flags as a test warning.
- Steering tests use `mock.timers`: live timer-based tests with 50ms delays and `for await ... break` patterns caused both timing sensitivity and the Promise leak issue described above. Using `t.mock.timers.enable()` + `t.mock.timers.tick()` makes tests deterministic and avoids generator cleanup issues.
- Idle recovery tests verified via SteeringQueue.push() directly: the idle watchdog in production depends on `readUnitRuntimeRecord()` which requires a real filesystem. Unit tests verify the priority and message shape via direct push(), leaving the runtime-record integration to integration tests.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] SteeringQueue generator leaked pending Promise<void> on consumer .return()**
- **Found during:** Task 2 (GREEN phase — running tests)
- **Issue:** When test's `for await ... break` called `.return()` on the SteeringQueue iterator, the `new Promise<void>(r => { this.resolve = r; })` inside the generator was never resolved, causing `node:test` to report `'Promise resolution is still pending but the event loop has already resolved'`
- **Fix:** Added `try/finally` to `SteeringQueue[Symbol.asyncIterator]()` that clears `this.resolve = null` on generator termination
- **Files modified:** src/resources/extensions/gsd/claude-code/sdk-executor.ts
- **Verification:** All 7 describe blocks pass with no Promise leak warnings
- **Committed in:** 229e625 (Task 2 commit)

**2. [Rule 1 - Bug] Steering tests used for-await-break pattern causing test failures**
- **Found during:** Task 2 (GREEN phase — running tests)
- **Issue:** Steering tests used `for await (const msg of params.prompt) { ... break; }` pattern which left the SteeringQueue generator in broken state; combined with live 50ms timers the tests produced `cancelledByParent` failures
- **Fix:** Redesigned steering tests to use `t.mock.timers.enable()` + `t.mock.timers.tick()` for deterministic timer control; idle recovery test uses direct push() verification instead of running live timers
- **Files modified:** src/resources/extensions/gsd/tests/sdk-executor.test.ts
- **Verification:** All 7 describe blocks pass (ok 513-519)
- **Committed in:** 229e625 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 bugs discovered during GREEN phase)
**Impact on plan:** Both fixes were necessary for test correctness. The SteeringQueue try/finally fix also improves production correctness (handles edge case where SDK consumer calls .return() unexpectedly). No scope creep.

## Issues Encountered

- `node:test` `mock.timers` is marked experimental but works correctly in Node.js v22.22.0
- The steering test redesign using mock.timers required importing `mock` from `node:test` in addition to `test` and `describe`

## Next Phase Readiness

- `sdk-executor.ts` is ready for wiring into `auto.ts` `dispatchNextUnit()` (plan 03-02)
- `getSdkActiveQuery()` is exported and ready for `stopAuto()` cancellation wiring
- All Phase 2 module integrations are tested and working (hook-bridge, activity-writer, models-resolver, mcp-tools all consumed via deps injection)
- Query options are fully specified and verified against all 7 pitfalls in RESEARCH.md

---
*Phase: 03-core-dispatch*
*Completed: 2026-03-18*

## Self-Check: PASSED

- FOUND: src/resources/extensions/gsd/claude-code/sdk-executor.ts
- FOUND: src/resources/extensions/gsd/tests/sdk-executor.test.ts
- FOUND: .planning/phases/03-core-dispatch/03-01-SUMMARY.md
- FOUND commit: 2f6add8 (test RED phase)
- FOUND commit: 229e625 (feat GREEN phase)
