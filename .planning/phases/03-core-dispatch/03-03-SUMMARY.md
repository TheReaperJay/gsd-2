---
phase: 03-core-dispatch
plan: "03"
subsystem: api
tags: [sdk-executor, idle-watchdog, hook-bridge, requirements]

# Dependency graph
requires:
  - phase: 03-core-dispatch
    provides: sdk-executor.ts with hook bridge, idle watchdog, and steering infrastructure from 03-01 and 03-02
provides:
  - Idle tracking wrappers (effectiveOnToolStart/effectiveOnToolEnd) wired into createHookBridge() so tool events reset lastActivityAt on production path
  - Dead code removal: trackingOnToolStart/trackingOnToolEnd void suppression and misleading "Override hook bridge" comment gone
  - EXEC-06 requirement text updated to match locked design: time-based supervision via steering channel and Stop hook, not SDK maxTurns
  - Test proving tracking wrapper pattern correctly resets timestamp and delegates to original callback
affects: [03-VERIFICATION.md, REQUIREMENTS.md, Phase 5 idle watchdog work]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared outer-scope variable pattern: declare lastActivityAt at function scope so production-path wrappers and setInterval share the same instance"
    - "Tracking wrapper delegation: effectiveOnToolStart = (event) => { lastActivityAt = Date.now(); onToolStart(event); } before hook bridge creation"

key-files:
  created: []
  modified:
    - src/resources/extensions/gsd/claude-code/sdk-executor.ts
    - src/resources/extensions/gsd/tests/sdk-executor.test.ts
    - .planning/REQUIREMENTS.md

key-decisions:
  - "Declare lastActivityAt at outer function scope (before if (_deps) block) so tracking wrappers and setInterval share the same variable — not inside if (idleTimeoutMs > 0) block"
  - "EXEC-06 requirement text updated to reflect locked decision: time-based supervision via steering+Stop hook is the implementation, not SDK maxTurns"

patterns-established:
  - "Production-path wrappers created before createHookBridge() — effectiveOnToolStart/effectiveOnToolEnd conditionally wrap on idleTimeoutMs > 0"

requirements-completed: [EXEC-01, EXEC-03, EXEC-04, EXEC-06, SUP-03, SUP-04]

# Metrics
duration: 4min
completed: 2026-03-18
---

# Phase 3 Plan 03: Gap Closure — Idle Tracking Wrappers + EXEC-06 Requirement Update

**Idle tracking wrappers wired into hook bridge so tool events reset lastActivityAt; EXEC-06 requirement text updated to match the locked time-based supervision design**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-18T08:28:27Z
- **Completed:** 2026-03-18T08:32:47Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Wired `effectiveOnToolStart`/`effectiveOnToolEnd` tracking wrappers into `createHookBridge()` on production path — tool events now reset `lastActivityAt` so idle watchdog is activity-sensitive, not a wall-clock alarm
- Removed dead code: `trackingOnToolStart`/`trackingOnToolEnd` with `void` suppression and misleading "Override hook bridge" comment — the idle watchdog block is now clean (just sets up `setInterval`)
- Added test "Idle tracking wrappers reset lastActivityAt on tool events" proving the wrapper pattern correctly updates the timestamp and delegates to the original callback
- Updated REQUIREMENTS.md EXEC-06 from "configurable maxTurns limit" to "time-based supervision via steering channel and Stop hook" — requirement text now matches implementation

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire tracking wrappers into hook bridge and add idle reset test** - `fe8ad7e` (fix)
2. **Task 2: Update EXEC-06 requirement text to match time-based supervision design** - `a6f81f4` (fix)

## Files Created/Modified
- `src/resources/extensions/gsd/claude-code/sdk-executor.ts` - Declare `lastActivityAt` at outer scope; create `effectiveOnToolStart`/`effectiveOnToolEnd` before `createHookBridge()`; pass them to hook bridge; remove dead tracking wrapper code and misleading comment from idle watchdog block
- `src/resources/extensions/gsd/tests/sdk-executor.test.ts` - Add "Idle tracking wrappers reset lastActivityAt on tool events" test
- `.planning/REQUIREMENTS.md` - Update EXEC-06 text to reflect time-based supervision design

## Decisions Made
- Declared `lastActivityAt` at outer function scope (before the `if (_deps)` block) rather than inside `if (idleTimeoutMs > 0)` — this is the minimal change that lets both the production-path tracking wrappers and the idle watchdog `setInterval` reference the same variable
- ROADMAP.md Phase 3 success criteria item 5 already used the correct "time-based supervision" wording — only REQUIREMENTS.md required updating

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 3 is now complete: all 3 plans done, both VERIFICATION.md gaps closed
- Phase 4 (Onboarding & Auth) can proceed: AUTH-01, AUTH-02 requirements are next
- Phase 5 idle watchdog work (OBS-04) builds on the now-correct idle tracking infrastructure in sdk-executor.ts

## Self-Check: PASSED

All files verified present. All commits verified.

---
*Phase: 03-core-dispatch*
*Completed: 2026-03-18*
