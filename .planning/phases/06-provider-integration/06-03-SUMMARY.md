---
phase: 06-provider-integration
plan: 03
subsystem: provider-integration
tags: [claude-code, model-registry, provider-registration, stream-adapter, onboarding]

# Dependency graph
requires:
  - phase: 06-02
    provides: stream-adapter.ts factory with StreamAdapterDeps interface and createClaudeCodeStream
  - phase: 06-01
    provides: providerData field on ProviderConfigInput and Model types
provides:
  - stream-adapter-state.ts neutral module with per-dispatch setters/getters that break the auto.ts->index.ts circular import
  - pi.registerProvider("claude-code") call in GSD extension init with 3 models (opus, sonnet, haiku)
  - Onboarding sets setDefaultModelAndProvider to claude-code:claude-opus-4-6 after credential store
  - Test coverage for stream-adapter-state round-trips, provider config structure, and default model constants
affects: [07-auto-dispatch-integration, cli-boot, tui-model-selection]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Neutral state module pattern: per-dispatch mutable state lives in a separate module that both writer (auto.ts) and reader (index.ts) can import without circular dependency"
    - "Getter callbacks wired at registration time, called per invocation — factory captures deps object, not state values"

key-files:
  created:
    - src/resources/extensions/gsd/claude-code/stream-adapter-state.ts
    - src/resources/extensions/gsd/tests/claude-code-provider-registration.test.ts
  modified:
    - src/resources/extensions/gsd/index.ts
    - src/onboarding.ts

key-decisions:
  - "stream-adapter-state.ts is a neutral module owning per-dispatch mutable state — auto.ts writes setters, index.ts wires getters into StreamAdapterDeps callbacks, no circular import"
  - "SettingsManager.create(agentDir) called inline in runClaudeCodeCliCheck rather than passing settingsManager as a parameter — onboarding runs once, instantiation cost is negligible"

patterns-established:
  - "Provider registration in GSD extension init: streamAdapterDeps object constructed from getter callbacks, then passed to createClaudeCodeStream factory before registerProvider call"
  - "Model ID prefix convention: all claude-code models use 'claude-code:' prefix to avoid collision with Anthropic provider model IDs"

requirements-completed: [PROV-03, PROV-04]

# Metrics
duration: 7min
completed: 2026-03-19
---

# Phase 06 Plan 03: Provider Registration Summary

**claude-code registered as Pi provider with 3 models (opus/sonnet/haiku), stream adapter wired via neutral state module, onboarding sets default model to claude-code:claude-opus-4-6**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-19T09:09:51Z
- **Completed:** 2026-03-19T09:16:49Z
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- Created `stream-adapter-state.ts` neutral module that breaks the potential auto.ts->index.ts circular import by owning per-dispatch mutable state with separate setters (for auto.ts) and getters (for index.ts StreamAdapterDeps callbacks)
- Registered claude-code as a Pi provider in GSD extension init with 3 models: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 — each with prefixed IDs, providerData sdkAlias, and zero-cost billing entries (subscription delegates billing)
- Fixed onboarding to call `setDefaultModelAndProvider('claude-code', 'claude-code:claude-opus-4-6')` after credential store so TUI boots with a valid model selection

## Task Commits

Each task was committed atomically:

1. **Task 1: Create stream-adapter-state.ts and register claude-code provider** - `a5fe6c1` (feat)
2. **Task 2: Fix onboarding default model + tests** - `13fb060` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src/resources/extensions/gsd/claude-code/stream-adapter-state.ts` — Neutral per-dispatch state module with setters (setStreamAdapterUnitInfo, setStreamAdapterBasePath, setStreamAdapterIsUnitDone) and getters (getStreamAdapterUnitInfo, getStreamAdapterBasePath, getStreamAdapterIsUnitDone)
- `src/resources/extensions/gsd/index.ts` — Added resolveAutoSupervisorConfig import, stream-adapter imports, stream-adapter-state getter imports, and pi.registerProvider("claude-code") call with 3 models inside export default function body
- `src/onboarding.ts` — Imported SettingsManager; added setDefaultModelAndProvider call after authStorage.set in runClaudeCodeCliCheck
- `src/resources/extensions/gsd/tests/claude-code-provider-registration.test.ts` — 13 tests covering stream-adapter-state setters/getters, provider config model structure/sdkAlias/prefixes, and onboarding default model constants

## Decisions Made

- Used `SettingsManager.create(agentDir)` inline in `runClaudeCodeCliCheck` rather than threading a settingsManager parameter through the entire onboarding call chain. Onboarding runs once per fresh install; the instantiation cost is negligible and the approach keeps the function signatures clean.
- The `resolveAutoSupervisorConfig` function returns `AutoSupervisorConfig` which has an extra `model?` field beyond what `StreamAdapterDeps.getSupervisorConfig` requires. TypeScript structural typing accepts this as compatible — no cast or wrapper needed.

## Deviations from Plan

None — plan executed exactly as written. The import of `resolveAutoSupervisorConfig` was not already present in index.ts (plan said "check if already imported"), discovered and added as part of the planned work.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- claude-code models are now in the model registry and selectable in the TUI
- Provider availability gated by authStorage.hasAuth("claude-code") via model registry's getAvailable()
- auto.ts will need to call the stream-adapter-state setters (setStreamAdapterUnitInfo, setStreamAdapterBasePath, setStreamAdapterIsUnitDone) before each pi.sendMessage() dispatch in the next phase

---
*Phase: 06-provider-integration*
*Completed: 2026-03-19*

## Self-Check: PASSED

All files verified present:
- FOUND: src/resources/extensions/gsd/claude-code/stream-adapter-state.ts
- FOUND: src/resources/extensions/gsd/tests/claude-code-provider-registration.test.ts
- FOUND: .planning/phases/06-provider-integration/06-03-SUMMARY.md

All commits verified:
- FOUND: a5fe6c1 (Task 1)
- FOUND: 13fb060 (Task 2)
