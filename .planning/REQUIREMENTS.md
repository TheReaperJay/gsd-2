# Requirements: GSD-2 Claude Code Integration

**Defined:** 2026-03-17
**Core Value:** Autonomous, reliable code generation that takes a user from idea to shipped software without manual intervention

## v1.0 Requirements

Requirements for Claude Code integration. Each maps to roadmap phases.

### Execution Backend

- [x] **EXEC-01**: Subscription user can dispatch GSD units (research/plan/execute/complete) through Claude Agent SDK `query()` instead of Pi's agent loop
- [x] **EXEC-02**: Post-unit pipeline (commit, doctor, state rebuild, artifact verify, completion key) runs identically on both Pi and Claude Code paths via shared function
- [x] **EXEC-03**: SDK errors (max_turns_reached, error_during_execution, error_max_budget_usd) map to GSD error handling and model fallback logic
- [x] **EXEC-04**: User can cancel a running Claude Code unit via AbortController wired to stopAuto()
- [ ] **EXEC-05**: Interrupted Claude Code units can resume via SDK session ID on retry
- [x] **EXEC-06**: Each unit type has a configurable maxTurns limit to bound execution length

### Custom Tools

- [x] **TOOL-01**: GSD's 3 custom tools (save_decision, update_requirement, save_summary) are available in Claude Code sessions via in-process `createSdkMcpServer()`
- [x] **TOOL-02**: All prompts use AsyncIterable wrapper for streaming input (required for MCP tools to function)

### Authentication & Onboarding

- [ ] **AUTH-01**: User can select "Claude Code (Subscription)" as provider during onboarding
- [ ] **AUTH-02**: Onboarding verifies Claude Code CLI is installed and authenticated
- [x] **AUTH-03**: GSD model IDs map correctly to Claude Code model aliases (opus, sonnet, haiku)
- [x] **AUTH-04**: Auth storage handles `type: "claude-code"` credential type (no token stored, signals "use Claude Code")

### Observability & Recovery

- [x] **OBS-01**: SDK streaming output is captured to `.gsd/activity/` log in existing activity log format (translated from SDK events, not a new format)
- [x] **OBS-02**: Per-unit cost is accumulated from SDK result messages and reported in GSD metrics
- [ ] **OBS-03**: Crash recovery detects incomplete Claude Code units via lock file and falls back to activity log for forensics
- [ ] **OBS-04**: Idle watchdog detects hung Claude Code sessions via PreToolUse/PostToolUse hooks and SDKToolProgressMessage elapsed_time_seconds

### Supervision & Parity

- [x] **SUP-01**: SDK PreToolUse/PostToolUse hooks provide real-time per-tool progress to TUI (tool name, file path, command) — matching Pi's tool_call/tool_result event visibility
- [x] **SUP-02**: Effort/thinking level mapping from GSD complexity classifier to SDK `thinking`/`effort` options
- [x] **SUP-03**: Steering channel (AsyncIterable prompt with priority hints) enables mid-execution wrapup warnings and focus redirects — matching Pi's sendMessage steering
- [x] **SUP-04**: SDK Stop hook enables GSD to block premature completion — matching Pi's agent loop continuation control

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Enhanced Integration

- **ENH-03**: Claude Team/Enterprise-specific auth flows (if different from Max/Pro)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Pi core modifications | Integration is additive only — no changes to pi-ai or pi-agent-core |
| Provider-level integration (streamSimple) | SDK is an agent, not inference endpoint — architecturally incompatible |
| Non-Anthropic providers via Claude Code | Claude Code is Anthropic-only |
| Claude Code system prompt preset | GSD is the orchestrator; its prompts define agent behavior |
| CLAUDE.md loading via SDK settingSources | Would inject conflicting instructions |
| External MCP server for custom tools | In-process createSdkMcpServer is simpler and sufficient |
| V2 unstable SDK session API | Unstable (@alpha), missing system prompts/MCP/budget/thinking/interrupt — strict subset of query() with AsyncIterable. Researched and rejected. |
| Claude Code-specific behaviors | Claude Code replicates existing provider behavior exactly — no unique UX, thresholds, formats, or permission models |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EXEC-01 | Phase 3 | Complete |
| EXEC-02 | Phase 1 | Complete |
| EXEC-03 | Phase 3 | Complete |
| EXEC-04 | Phase 3 | Complete |
| EXEC-05 | Phase 5 | Pending |
| EXEC-06 | Phase 3 | Complete |
| TOOL-01 | Phase 2 | Complete |
| TOOL-02 | Phase 2 | Complete |
| AUTH-01 | Phase 4 | Pending |
| AUTH-02 | Phase 4 | Pending |
| AUTH-03 | Phase 2 | Complete |
| AUTH-04 | Phase 2 | Complete |
| OBS-01 | Phase 2 | Complete |
| OBS-02 | Phase 2 | Complete |
| OBS-03 | Phase 5 | Pending |
| OBS-04 | Phase 5 | Pending |
| SUP-01 | Phase 2 | Complete |
| SUP-02 | Phase 2 | Complete |
| SUP-03 | Phase 3 | Complete |
| SUP-04 | Phase 3 | Complete |

**Coverage:**
- v1 requirements: 20 total
- Mapped to phases: 20
- Unmapped: 0

---
*Requirements defined: 2026-03-17*
*Last updated: 2026-03-17 after discuss-phase 1 decisions*
