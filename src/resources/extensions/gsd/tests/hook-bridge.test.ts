/**
 * Unit tests for hook-bridge.ts — verifies that SDK PreToolUse/PostToolUse/PostToolUseFailure
 * hooks translate into GSD tool events with the correct shapes.
 *
 * Covers:
 * - PreToolUse emits onToolStart with correct toolCallId, toolName, input
 * - PostToolUse emits onToolEnd with isError: false
 * - PostToolUseFailure emits onToolEnd with isError: true (Pitfall 4 prevention)
 * - Write tool with CONTEXT.md path triggers shouldBlockContextWrite and returns { continue: false }
 * - Edit tool with CONTEXT.md path also triggers the gate
 * - Bash tool does NOT trigger the CONTEXT.md gate
 * - When shouldBlockContextWrite returns block: false, PreToolUse returns {}
 * - All 3 hook types (PreToolUse, PostToolUse, PostToolUseFailure) are present in returned config
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookBridge } from '../claude-code/hook-bridge.js';
import type { GsdToolEvent, HookBridgeConfig } from '../claude-code/hook-bridge.js';

function makeConfig(overrides?: Partial<HookBridgeConfig>): {
  config: HookBridgeConfig;
  startEvents: GsdToolEvent[];
  endEvents: GsdToolEvent[];
} {
  const startEvents: GsdToolEvent[] = [];
  const endEvents: GsdToolEvent[] = [];
  const config: HookBridgeConfig = {
    onToolStart: (e) => startEvents.push(e),
    onToolEnd: (e) => endEvents.push(e),
    shouldBlockContextWrite: (toolName, inputPath, _milestoneId, _depthVerified) => {
      if (inputPath.includes('CONTEXT.md')) {
        return { block: true, reason: 'depth verification required' };
      }
      return { block: false };
    },
    getMilestoneId: () => 'M001',
    isDepthVerified: () => false,
    ...overrides,
  };
  return { config, startEvents, endEvents };
}

// ─── Structure: all 3 hook types present ─────────────────────────────────────

test('hook-bridge: returned object has PreToolUse, PostToolUse, PostToolUseFailure keys', () => {
  const { config } = makeConfig();
  const hooks = createHookBridge(config);
  assert.ok('PreToolUse' in hooks, 'should have PreToolUse');
  assert.ok('PostToolUse' in hooks, 'should have PostToolUse');
  assert.ok('PostToolUseFailure' in hooks, 'should have PostToolUseFailure');
});

test('hook-bridge: each hook type is an array with at least one entry containing a hooks array', () => {
  const { config } = makeConfig();
  const hooks = createHookBridge(config);
  assert.ok(Array.isArray(hooks.PreToolUse), 'PreToolUse should be an array');
  assert.ok(Array.isArray(hooks.PostToolUse), 'PostToolUse should be an array');
  assert.ok(Array.isArray(hooks.PostToolUseFailure), 'PostToolUseFailure should be an array');
  assert.ok(Array.isArray(hooks.PreToolUse[0].hooks), 'PreToolUse[0].hooks should be an array');
  assert.ok(Array.isArray(hooks.PostToolUse[0].hooks), 'PostToolUse[0].hooks should be an array');
  assert.ok(Array.isArray(hooks.PostToolUseFailure[0].hooks), 'PostToolUseFailure[0].hooks should be an array');
});

// ─── PreToolUse: emits onToolStart ────────────────────────────────────────────

test('hook-bridge: PreToolUse calls onToolStart with toolCallId, toolName, and input', async () => {
  const { config, startEvents } = makeConfig();
  const hooks = createHookBridge(config);
  const handler = hooks.PreToolUse[0].hooks[0];

  await handler({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'toolu_01ABC',
    session_id: 'sess_1',
    cwd: '/tmp',
  });

  assert.strictEqual(startEvents.length, 1, 'should have one start event');
  assert.strictEqual(startEvents[0].toolCallId, 'toolu_01ABC');
  assert.strictEqual(startEvents[0].toolName, 'Bash');
  assert.deepEqual(startEvents[0].input, { command: 'ls' });
});

// ─── PostToolUse: emits onToolEnd with isError: false ────────────────────────

test('hook-bridge: PostToolUse calls onToolEnd with isError: false', async () => {
  const { config, endEvents } = makeConfig();
  const hooks = createHookBridge(config);
  const handler = hooks.PostToolUse[0].hooks[0];

  await handler({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: 'file1\nfile2\n',
    tool_use_id: 'toolu_02XYZ',
  });

  assert.strictEqual(endEvents.length, 1, 'should have one end event');
  assert.strictEqual(endEvents[0].toolCallId, 'toolu_02XYZ');
  assert.strictEqual(endEvents[0].toolName, 'Bash');
  assert.strictEqual(endEvents[0].isError, false);
});

// ─── PostToolUseFailure: emits onToolEnd with isError: true ──────────────────

test('hook-bridge: PostToolUseFailure calls onToolEnd with isError: true', async () => {
  const { config, endEvents } = makeConfig();
  const hooks = createHookBridge(config);
  const handler = hooks.PostToolUseFailure[0].hooks[0];

  await handler({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/test.ts', content: 'x' },
    tool_use_id: 'toolu_03ERR',
    error: new Error('write failed'),
  });

  assert.strictEqual(endEvents.length, 1, 'should have one end event');
  assert.strictEqual(endEvents[0].toolCallId, 'toolu_03ERR');
  assert.strictEqual(endEvents[0].toolName, 'Write');
  assert.strictEqual(endEvents[0].isError, true);
});

// ─── CONTEXT.md gate: Write tool triggers shouldBlockContextWrite ─────────────

test('hook-bridge: Write tool with CONTEXT.md path returns { continue: false } when blocked', async () => {
  const { config, startEvents } = makeConfig();
  const hooks = createHookBridge(config);
  const handler = hooks.PreToolUse[0].hooks[0];

  const result = await handler({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '.gsd/milestones/M001/M001-CONTEXT.md', content: 'x' },
    tool_use_id: 'toolu_04CTX',
    session_id: 'sess_1',
    cwd: '/tmp',
  });

  // onToolStart should still be called before the gate check
  assert.strictEqual(startEvents.length, 1, 'onToolStart should be called');
  assert.strictEqual(startEvents[0].toolCallId, 'toolu_04CTX');

  // The gate should block
  assert.deepEqual(result, { continue: false, stopReason: 'depth verification required' });
});

test('hook-bridge: Write tool with non-CONTEXT.md path returns {} when not blocked', async () => {
  const { config } = makeConfig();
  const hooks = createHookBridge(config);
  const handler = hooks.PreToolUse[0].hooks[0];

  const result = await handler({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: 'src/index.ts', content: 'x' },
    tool_use_id: 'toolu_05OK',
    session_id: 'sess_1',
    cwd: '/tmp',
  });

  assert.deepEqual(result, {}, 'should return {} when not blocked');
});

// ─── CONTEXT.md gate: Edit tool triggers shouldBlockContextWrite ──────────────

test('hook-bridge: Edit tool with CONTEXT.md path returns { continue: false } when blocked', async () => {
  const { config } = makeConfig();
  const hooks = createHookBridge(config);
  const handler = hooks.PreToolUse[0].hooks[0];

  const result = await handler({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: '.gsd/milestones/M001/M001-CONTEXT.md', old_string: 'a', new_string: 'b' },
    tool_use_id: 'toolu_06EDIT',
    session_id: 'sess_1',
    cwd: '/tmp',
  });

  assert.deepEqual(result, { continue: false, stopReason: 'depth verification required' });
});

// ─── CONTEXT.md gate: Bash tool does NOT trigger the gate ────────────────────

test('hook-bridge: Bash tool does NOT trigger the CONTEXT.md gate', async () => {
  let gateCallCount = 0;
  const { config } = makeConfig({
    shouldBlockContextWrite: (toolName, inputPath, _milestoneId, _depthVerified) => {
      gateCallCount++;
      return { block: false };
    },
  });
  const hooks = createHookBridge(config);
  const handler = hooks.PreToolUse[0].hooks[0];

  await handler({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'cat .gsd/milestones/M001/M001-CONTEXT.md' },
    tool_use_id: 'toolu_07BASH',
    session_id: 'sess_1',
    cwd: '/tmp',
  });

  assert.strictEqual(gateCallCount, 0, 'shouldBlockContextWrite should NOT be called for Bash');
});

// ─── shouldBlockContextWrite receives lowercased tool name ───────────────────

test('hook-bridge: shouldBlockContextWrite is called with lowercased tool name', async () => {
  const capturedToolNames: string[] = [];
  const { config } = makeConfig({
    shouldBlockContextWrite: (toolName, _inputPath, _milestoneId, _depthVerified) => {
      capturedToolNames.push(toolName);
      return { block: false };
    },
  });
  const hooks = createHookBridge(config);
  const handler = hooks.PreToolUse[0].hooks[0];

  await handler({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: 'src/test.ts', content: 'x' },
    tool_use_id: 'toolu_08CASE',
    session_id: 'sess_1',
    cwd: '/tmp',
  });

  assert.strictEqual(capturedToolNames.length, 1);
  assert.strictEqual(capturedToolNames[0], 'write', 'should pass lowercased "write", not "Write"');
});

// ─── shouldBlockContextWrite receives getMilestoneId and isDepthVerified results ──

test('hook-bridge: shouldBlockContextWrite receives milestoneId from getMilestoneId()', async () => {
  const capturedArgs: Array<{ toolName: string; inputPath: string; milestoneId: string | null; depthVerified: boolean }> = [];
  const { config } = makeConfig({
    getMilestoneId: () => 'M999',
    isDepthVerified: () => true,
    shouldBlockContextWrite: (toolName, inputPath, milestoneId, depthVerified) => {
      capturedArgs.push({ toolName, inputPath, milestoneId, depthVerified });
      return { block: false };
    },
  });
  const hooks = createHookBridge(config);
  const handler = hooks.PreToolUse[0].hooks[0];

  await handler({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: 'src/test.ts', content: 'x' },
    tool_use_id: 'toolu_09MID',
    session_id: 'sess_1',
    cwd: '/tmp',
  });

  assert.strictEqual(capturedArgs[0].milestoneId, 'M999');
  assert.strictEqual(capturedArgs[0].depthVerified, true);
});

// ─── Input path fallback: .path field ────────────────────────────────────────

test('hook-bridge: Write tool uses .path as fallback when .file_path is absent', async () => {
  let capturedPath = '';
  const { config } = makeConfig({
    shouldBlockContextWrite: (_toolName, inputPath, _milestoneId, _depthVerified) => {
      capturedPath = inputPath;
      return { block: false };
    },
  });
  const hooks = createHookBridge(config);
  const handler = hooks.PreToolUse[0].hooks[0];

  await handler({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { path: '/some/other/path.ts', content: 'x' },
    tool_use_id: 'toolu_10PATH',
    session_id: 'sess_1',
    cwd: '/tmp',
  });

  assert.strictEqual(capturedPath, '/some/other/path.ts', 'should use .path as fallback');
});

// ─── Correctness: hook does not call onToolStart for wrong hook_event_name ────

test('hook-bridge: PostToolUse handler ignores non-PostToolUse event names', async () => {
  const { config, endEvents } = makeConfig();
  const hooks = createHookBridge(config);
  const handler = hooks.PostToolUse[0].hooks[0];

  const result = await handler({
    hook_event_name: 'PreToolUse',  // wrong event name passed to PostToolUse handler
    tool_name: 'Bash',
    tool_input: {},
    tool_use_id: 'toolu_11WRONG',
    session_id: 'sess_1',
    cwd: '/tmp',
  });

  assert.strictEqual(endEvents.length, 0, 'should not emit event for wrong hook_event_name');
  assert.deepEqual(result, {}, 'should return {} for non-matching event');
});
