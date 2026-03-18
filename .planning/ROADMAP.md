# Roadmap: GSD-2 Claude Code Integration

## Overview

This milestone adds a second execution path to GSD-2's agent dispatch. Subscription users (Claude Max/Pro) can route units through the Claude Agent SDK instead of Pi's agent loop, enabling TOS-compliant use of their Anthropic subscription. The integration is a surgical branch-and-rejoin at one call site in `auto.ts`: the Claude Code path calls `sdkExecuteUnit()` and then rejoins the shared post-unit pipeline. The state machine, orchestration layer, and all existing execution paths remain untouched. Five phases deliver the integration in strict dependency order, with the highest-severity pitfall (state corruption from missing post-unit steps) structurally prevented before any new execution code is written.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Pipeline Extraction** - Extract post-unit pipeline into shared function; prevents state corruption before any new dispatch code is written (completed 2026-03-17)
- [x] **Phase 2: Core Infrastructure** - Build all leaf-node modules (routing, tools, activity writer) and supporting auth/model changes (completed 2026-03-17)
- [x] **Phase 3: Core Dispatch** - Implement sdk-executor and wire the auto.ts branch; all critical pitfalls addressed here (completed 2026-03-18)
- [x] **Phase 4: Onboarding & Auth** - Add Claude Code provider to onboarding flow with CLI prerequisite check (completed 2026-03-18)
- [ ] **Phase 5: Integration & Recovery** - Validate session resume, crash recovery forensics, idle watchdog, and concurrency behavior

## Phase Details

### Phase 1: Pipeline Extraction
**Goal**: The post-unit pipeline runs identically on both execution paths via a single shared function, making it structurally impossible for either path to omit steps
**Depends on**: Nothing (first phase)
**Requirements**: EXEC-02
**Success Criteria** (what must be TRUE):
  1. A single `runPostUnitPipeline()` function exists and contains all steps previously inline in the Pi dispatch path (commit, doctor, state rebuild, artifact verify, completion key, metrics)
  2. The existing Pi path calls `runPostUnitPipeline()` and passes all existing tests without behavioral change
  3. No post-unit logic remains duplicated between the Pi path and any future Claude Code path
**Plans:** 1/1 plans complete

Plans:
- [x] 01-01-PLAN.md — Extract Section 1 of handleAgentEnd into runPostUnitPipeline() shared function

### Phase 2: Core Infrastructure
**Goal**: All supporting modules exist for the SDK executor to be built against — routing, tools, activity writer, hook bridge, auth storage for the claude-code credential type, model alias mappings, and thinking/effort configuration
**Depends on**: Phase 1
**Requirements**: TOOL-01, TOOL-02, AUTH-03, AUTH-04, OBS-01, OBS-02, SUP-01, SUP-02
**Success Criteria** (what must be TRUE):
  1. `provider-routing.ts` reads auth.json and returns a routing decision (Pi vs SDK) that downstream code can consume
  2. GSD's 3 custom tools (save_decision, update_requirement, save_summary) are registered via `createSdkMcpServer()` with correct Zod schemas and can be called in a test SDK session
  3. All prompts passed to the SDK use `AsyncIterable` wrapping (not static strings), confirmed by code inspection
  4. Auth storage accepts and persists a `type: "claude-code"` credential with no token field
  5. GSD model IDs (e.g., `claude-opus-4`) resolve to Claude Code aliases (e.g., `opus`) via `models-resolver.ts`
  6. SDK streaming output is translated into existing activity log format and written to `.gsd/activity/` so session-forensics.ts can parse it without changes
  7. Per-unit cost is accumulated from `total_cost_usd` in SDK result messages and surfaced in GSD metrics
  8. SDK hook bridge module translates PreToolUse/PostToolUse callbacks into GSD's existing tool_call/tool_result event format, enabling TUI progress, inFlightTools tracking, and idle detection to work identically to Pi path
  9. GSD complexity classifier maps to SDK `thinking`/`effort` options, matching the behavior parity of existing Pi provider thinking configuration
**Plans:** 5/5 plans complete

Plans:
- [ ] 02-01-PLAN.md — Auth credential type extension + provider routing
- [ ] 02-02-PLAN.md — Model alias resolution + thinking/effort tier configuration
- [ ] 02-03-PLAN.md — MCP tool registration with TypeBox-to-Zod conversion
- [ ] 02-04-PLAN.md — SDK hook bridge for tool events and CONTEXT.md gate
- [ ] 02-05-PLAN.md — Activity writer with JSONL format and cost extraction

### Phase 3: Core Dispatch
**Goal**: A subscription user can dispatch a single GSD unit through the Claude Code path end-to-end, with full supervision parity — hooks, steering, cancellation, and post-unit pipeline all functioning identically to the Pi path
**Depends on**: Phase 2
**Requirements**: EXEC-01, EXEC-03, EXEC-04, EXEC-06, SUP-03, SUP-04
**Success Criteria** (what must be TRUE):
  1. A user with `type: "claude-code"` in auth.json can run a GSD unit (any type) and it executes via `sdkExecuteUnit()` instead of Pi's agent loop
  2. The post-unit pipeline runs exactly once per unit completion, regardless of whether the unit succeeded or errored
  3. SDK error subtypes (max_turns_reached, error_during_execution, error_max_budget_usd) map to the correct GSD error handling branches and trigger model fallback where applicable
  4. User can cancel a running Claude Code unit via `stopAuto()` using interrupt() (graceful) → close() (forceful) escalation, with no orphaned lock files
  5. Each unit type's execution length is bounded by time-based supervision (soft/idle/hard timeouts via steering + Stop hook)
  6. Steering channel (AsyncIterable with priority hints) delivers wrapup warnings and focus redirects at turn boundaries, matching Pi's sendMessage steering behavior
  7. SDK Stop hook prevents premature completion when GSD determines the unit isn't done, matching Pi's agent loop continuation control
  8. TUI shows per-tool progress during Claude Code execution identically to Pi execution (tool name, file path, command via hook bridge from Phase 2)
**Plans:** 3/3 plans complete

Plans:
- [x] 03-01-PLAN.md — SDK executor: SteeringQueue + sdkExecuteUnit() with steering, stop hook, error mapping (TDD)
- [x] 03-02-PLAN.md — Wire auto.ts dispatch branch and stopAuto() cancellation
- [ ] 03-03-PLAN.md — Gap closure: wire idle tracking wrappers into hook bridge + update EXEC-06 requirement text

### Phase 4: Onboarding & Auth
**Goal**: A new user can select Claude Code as their provider during GSD onboarding and be guided through the CLI prerequisite check before any execution is attempted
**Depends on**: Phase 2
**Requirements**: AUTH-01, AUTH-02
**Success Criteria** (what must be TRUE):
  1. "Claude Code (Subscription)" appears as a selectable provider option in the GSD onboarding flow
  2. Selecting Claude Code triggers a prerequisite check that verifies the `claude` CLI is installed and authenticated; the user sees a clear error message if either check fails
  3. Completing onboarding with Claude Code selected writes a `type: "claude-code"` credential to auth storage (no token stored)
**Plans:** 1/1 plans complete

Plans:
- [ ] 04-01-PLAN.md — Add Claude Code CLI provider to onboarding with two-step prerequisite verification

### Phase 5: Integration & Recovery
**Goal**: The full Claude Code execution path is validated under real conditions — interrupted units resume correctly, crash recovery reads activity logs for forensics, the idle watchdog detects hung sessions, and parallel workers do not corrupt each other
**Depends on**: Phase 3, Phase 4
**Requirements**: EXEC-05, OBS-03, OBS-04
**Success Criteria** (what must be TRUE):
  1. An interrupted Claude Code unit resumes from its SDK session ID on retry rather than restarting from scratch
  2. Crash recovery detects an incomplete Claude Code unit via lock file and reconstructs forensic context from the `.gsd/activity/` log
  3. The idle watchdog detects a hung Claude Code session via PreToolUse/PostToolUse hooks and SDKToolProgressMessage elapsed_time_seconds (using the same timeout thresholds as Pi, configurable) and triggers the existing timeout/recovery path
  4. Two or more parallel GSD workers each running Claude Code units produce correct, non-interleaved activity logs and post-unit pipeline executions
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Pipeline Extraction | 1/1 | Complete   | 2026-03-17 |
| 2. Core Infrastructure | 5/5 | Complete   | 2026-03-17 |
| 3. Core Dispatch | 3/3 | Complete   | 2026-03-18 |
| 4. Onboarding & Auth | 1/1 | Complete   | 2026-03-18 |
| 5. Integration & Recovery | 0/TBD | Not started | - |
