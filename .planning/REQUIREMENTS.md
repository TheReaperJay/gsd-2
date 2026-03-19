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
- [x] **EXEC-05**: Interrupted Claude Code units resume with forensic context from activity log on retry (same mechanism as Pi path)
- [x] **EXEC-06**: Each unit type's execution length is bounded by time-based supervision (soft/idle/hard timeouts via steering channel and Stop hook) rather than SDK maxTurns

### Custom Tools

- [x] **TOOL-01**: GSD's 3 custom tools (save_decision, update_requirement, save_summary) are available in Claude Code sessions via in-process `createSdkMcpServer()`
- [x] **TOOL-02**: All prompts use AsyncIterable wrapper for streaming input (required for MCP tools to function)

### Authentication & Onboarding

- [x] **AUTH-01**: User can select "Claude Code (Subscription)" as provider during onboarding
- [x] **AUTH-02**: Onboarding verifies Claude Code CLI is installed and authenticated
- [x] **AUTH-03**: GSD model IDs map correctly to Claude Code model aliases (opus, sonnet, haiku)
- [x] **AUTH-04**: Auth storage handles `type: "claude-code"` credential type (no token stored, signals "use Claude Code")

### Observability & Recovery

- [x] **OBS-01**: SDK streaming output is captured to `.gsd/activity/` log in existing activity log format (translated from SDK events, not a new format)
- [x] **OBS-02**: Per-unit cost is accumulated from SDK result messages and reported in GSD metrics
- [x] **OBS-03**: Crash recovery detects incomplete Claude Code units via lock file and falls back to activity log for forensics
- [x] **OBS-04**: Idle watchdog detects hung Claude Code sessions via PreToolUse/PostToolUse hook timestamps (same timeout thresholds as Pi, configurable via supervisor config)

### Supervision & Parity

- [x] **SUP-01**: SDK PreToolUse/PostToolUse hooks provide real-time per-tool progress to TUI (tool name, file path, command) — matching Pi's tool_call/tool_result event visibility
- [x] **SUP-02**: Effort/thinking level mapping from GSD complexity classifier to SDK `thinking`/`effort` options
- [x] **SUP-03**: Steering channel (AsyncIterable prompt with priority hints) enables mid-execution wrapup warnings and focus redirects — matching Pi's sendMessage steering
- [x] **SUP-04**: SDK Stop hook enables GSD to block premature completion — matching Pi's agent loop continuation control

### Provider Integration

- [x] **PROV-01**: Pi's agent loop supports provider-managed tool execution — `provider_tool_start`/`provider_tool_end` stream events trigger `tool_execution_start`/`tool_execution_end` AgentEvents without calling `tool.execute()`
- [ ] **PROV-02**: The `streamSimple` implementation wraps the entire SDK `query()` session as a single `AssistantMessageEventStream` — SDK hook events (PreToolUse/PostToolUse) are translated to `provider_tool_start`/`provider_tool_end`, and the final SDK turn's text content is emitted as standard text events
- [ ] **PROV-03**: Claude-code is registered as a Pi provider via `modelRegistry.registerProvider()` with 3 models (opus, sonnet, haiku), a `streamSimple` implementation, and availability gated by `authStorage.hasAuth("claude-code")`
- [ ] **PROV-04**: Onboarding sets default model/provider after storing claude-code credential — TUI boots and shows claude-code models without "No model selected" error
- [ ] **PROV-05**: The bolt-on SDK dispatch branch in `auto.ts` is removed — all providers dispatch through Pi's standard agent loop → streamSimple pipeline
- [ ] **PROV-06**: TUI displays real-time streaming text and tool execution visibility during Claude Code SDK sessions, matching the experience of other Pi providers

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Enhanced Integration

- **ENH-03**: Claude Team/Enterprise-specific auth flows (if different from Max/Pro)

## Out of Scope

| Feature | Reason |
|---------|--------|
| ~~Pi core modifications~~ | ~~Integration is additive only~~ — RESCINDED: pi-agent-core is vendored, provider-managed tool execution requires agent loop changes (Phase 6) |
| ~~Provider-level integration (streamSimple)~~ | ~~SDK is an agent, not inference endpoint~~ — RESCINDED: whole-session `query()` wrapping with hook-based event translation enables provider-level integration (Phase 6) |
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
| EXEC-05 | Phase 5 | Complete |
| EXEC-06 | Phase 3 | Complete |
| TOOL-01 | Phase 2 | Complete |
| TOOL-02 | Phase 2 | Complete |
| AUTH-01 | Phase 4 | Complete |
| AUTH-02 | Phase 4 | Complete |
| AUTH-03 | Phase 2 | Complete |
| AUTH-04 | Phase 2 | Complete |
| OBS-01 | Phase 2 | Complete |
| OBS-02 | Phase 2 | Complete |
| OBS-03 | Phase 5 | Complete |
| OBS-04 | Phase 5 | Complete |
| SUP-01 | Phase 2 | Complete |
| SUP-02 | Phase 2 | Complete |
| SUP-03 | Phase 3 | Complete |
| SUP-04 | Phase 3 | Complete |
| PROV-01 | Phase 6 | Planned |
| PROV-02 | Phase 6 | Planned |
| PROV-03 | Phase 6 | Planned |
| PROV-04 | Phase 6 | Planned |
| PROV-05 | Phase 6 | Planned |
| PROV-06 | Phase 6 | Planned |

**Coverage:**
- v1 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0

---
*Requirements defined: 2026-03-17*
*Last updated: 2026-03-19 — PROV-02 updated to reflect whole-session query() approach per Phase 6 architecture decision*
