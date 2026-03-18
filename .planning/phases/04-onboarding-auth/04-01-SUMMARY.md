---
phase: 04-onboarding-auth
plan: "01"
subsystem: auth
tags: [onboarding, claude-code, clack-prompts, spawnSync, auth-storage, tdd]

# Dependency graph
requires:
  - phase: 02-core-infrastructure
    provides: ClaudeCodeCredential type and AuthStorage.set('claude-code', { type: 'claude-code' }) persistence
  - phase: 03-core-dispatch
    provides: SDK executor routing that reads claude-code credential from provider-routing.ts

provides:
  - "'claude-code' added to LLM_PROVIDER_IDS — shouldRunOnboarding() skips when configured"
  - "checkClaudeCodeCli() exported pure function with injected spawnFn for testability"
  - "'Use local CLI' auth method option in Step 1 of onboarding wizard"
  - "'Claude Code (Subscription)' provider option in Step 2 CLI provider list"
  - "Two-step CLI prerequisite check: --version (binary detection) + auth status --json (loggedIn)"
  - "Prescribed failure messages for not-found and not-authenticated paths"
  - "Retry / choose-different-provider recovery flow for both failure cases"
  - "Unit tests: 6 tests covering AUTH-01 (shouldRunOnboarding) and AUTH-02 (CLI check logic)"

affects: [05-end-to-end, verify-work-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "checkClaudeCodeCli exported as pure function with optional spawnFn injection — separates testable logic from interactive UI wrapper"
    - "TDD RED/GREEN cycle: test file created with 6 failing tests before implementation, all 6 pass after"
    - "spawnSync ENOENT detection: check result.error first, then result.status !== 0 — covers both 'binary not found' and 'non-zero exit' cases"

key-files:
  created:
    - src/tests/onboarding-claude-code.test.ts
  modified:
    - src/onboarding.ts

key-decisions:
  - "checkClaudeCodeCli accepts optional injected spawnFn (defaults to real spawnSync) — makes CLI check unit-testable without requiring real claude binary"
  - "Two-step check design: version check (binary exists?) then auth status check (loggedIn?) — matches CONTEXT.md locked decision, no subscription type validation"
  - "offerCliRetry uses recursive call pattern matching runOAuthFlow() — consistent retry UX across all auth failure flows"
  - "authStorage.set('claude-code', { type: 'claude-code' }) — tokenless credential, presence is the signal per Phase 2 contract"

patterns-established:
  - "Pattern: Export pure check logic separately from interactive UI wrapper — checkClaudeCodeCli vs runClaudeCodeCliCheck"
  - "Pattern: TDD injectable spawnFn — inject via optional parameter defaulting to real implementation"

requirements-completed: [AUTH-01, AUTH-02]

# Metrics
duration: 5min
completed: 2026-03-18
---

# Phase 04 Plan 01: Claude Code Onboarding Auth Summary

**Claude Code added as selectable LLM provider in onboarding wizard with two-step spawnSync CLI prerequisite verification and 6 unit tests covering AUTH-01/AUTH-02**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-18T11:42:03Z
- **Completed:** 2026-03-18T11:47:02Z
- **Tasks:** 2 (TDD: RED commit + GREEN commit)
- **Files modified:** 2

## Accomplishments

- `'claude-code'` added to `LLM_PROVIDER_IDS` — `shouldRunOnboarding()` now returns `false` when the user has a Claude Code credential, preventing re-prompt on every boot
- `checkClaudeCodeCli()` exported with injected `spawnFn` for testability: runs `claude --version` then `claude auth status --json`, returns discriminated `{ ok, email? }` or `{ ok: false, reason }` result
- `runCliFlow()` / `runClaudeCodeCliCheck()` / `offerCliRetry()` private functions implement the Step 2 provider list, CLI spinner/error UI, and retry-or-choose-different-provider recovery matching the `runOAuthFlow()` pattern

## Task Commits

Each task committed atomically:

1. **Task 1: Create test scaffold for Claude Code onboarding (RED)** - `c9925d2` (test)
2. **Task 2: Implement Claude Code CLI onboarding flow (GREEN)** - `c44e51f` (feat)

## Files Created/Modified

- `src/tests/onboarding-claude-code.test.ts` — 6 unit tests using node:test/node:assert/strict; covers shouldRunOnboarding with claude-code credential (AUTH-01) and checkClaudeCodeCli with injected mock spawnFn for ENOENT, loggedIn:false, loggedIn:true+email, and unparseable JSON (AUTH-02)
- `src/onboarding.ts` — Added spawnSync import, 'claude-code' to LLM_PROVIDER_IDS, 'Use local CLI' option in Step 1 auth method select, `if (method === 'cli')` branch, exported `checkClaudeCodeCli()`, and private `runCliFlow()` / `runClaudeCodeCliCheck()` / `offerCliRetry()` functions

## Decisions Made

- Extracted `checkClaudeCodeCli()` as an exported pure function with optional `spawnFn` injection (defaults to real `spawnSync`) — this separates testable logic from the interactive `@clack/prompts` UI wrapper, making AUTH-02 unit-testable without a real `claude` binary
- Used recursive call pattern for `offerCliRetry()` (same as `runOAuthFlow()`) rather than a loop — consistent with existing onboarding retry UX, avoids loop state management
- Check `versionResult.error` first (ENOENT = binary not on PATH), then `versionResult.status !== 0` (non-zero exit) — covers both failure modes per Pitfall 1 from RESEARCH.md

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- AUTH-01 and AUTH-02 requirements fully satisfied; 6 unit tests green
- Pre-existing test failures in `github-client.test.ts`, `mcp-server.test.ts`, and `preferences-git.test.ts` are unrelated to this phase and were present before execution
- Phase 4 plan 01 complete; no blockers for verify-work or phase 5

---
*Phase: 04-onboarding-auth*
*Completed: 2026-03-18*
