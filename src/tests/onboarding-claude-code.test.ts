import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { shouldRunOnboarding, checkClaudeCodeCli } from "../onboarding.ts";
import { AuthStorage } from "@gsd/pi-coding-agent";

// ─── TTY mock ──────────────────────────────────────────────────────────────────

let savedTTY: boolean | undefined;

before(() => {
  savedTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
});

after(() => {
  process.stdin.isTTY = savedTTY;
});

// ─── AUTH-01: shouldRunOnboarding ─────────────────────────────────────────────

test("shouldRunOnboarding returns false when claude-code credential exists in auth storage", () => {
  const auth = AuthStorage.inMemory({ "claude-code": { type: "api_key", key: "cli-managed" } });
  assert.equal(shouldRunOnboarding(auth), false);
});

test("shouldRunOnboarding returns true when auth storage is empty", () => {
  const auth = AuthStorage.inMemory({});
  assert.equal(shouldRunOnboarding(auth), true);
});

// ─── AUTH-02: checkClaudeCodeCli ──────────────────────────────────────────────

test("checkClaudeCodeCli returns not-found when spawnSync reports ENOENT", () => {
  const mockSpawn = (_cmd: string, _args: string[], _opts?: object): SpawnSyncReturns<string> => ({
    pid: 0,
    output: [],
    stdout: "",
    stderr: "",
    status: null,
    signal: null,
    error: new Error("ENOENT: command not found"),
  });

  const result = checkClaudeCodeCli(mockSpawn as any);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not-found");
  }
});

test("checkClaudeCodeCli returns not-authenticated when version passes but auth status shows loggedIn false", () => {
  let callCount = 0;
  const mockSpawn = (_cmd: string, _args: string[], _opts?: object): SpawnSyncReturns<string> => {
    callCount++;
    if (callCount === 1) {
      // --version call: success
      return { pid: 0, output: [], stdout: "1.0.0", stderr: "", status: 0, signal: null };
    }
    // auth status call: loggedIn false
    return {
      pid: 0,
      output: [],
      stdout: '{"loggedIn":false}',
      stderr: "",
      status: 0,
      signal: null,
    };
  };

  const result = checkClaudeCodeCli(mockSpawn as any);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not-authenticated");
  }
});

test("checkClaudeCodeCli returns ok with email when version passes and auth status shows loggedIn true", () => {
  let callCount = 0;
  const mockSpawn = (_cmd: string, _args: string[], _opts?: object): SpawnSyncReturns<string> => {
    callCount++;
    if (callCount === 1) {
      return { pid: 0, output: [], stdout: "1.0.0", stderr: "", status: 0, signal: null };
    }
    return {
      pid: 0,
      output: [],
      stdout: '{"loggedIn":true,"email":"user@example.com"}',
      stderr: "",
      status: 0,
      signal: null,
    };
  };

  const result = checkClaudeCodeCli(mockSpawn as any);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.email, "user@example.com");
  }
});

test("checkClaudeCodeCli returns not-authenticated when auth status stdout is not valid JSON", () => {
  let callCount = 0;
  const mockSpawn = (_cmd: string, _args: string[], _opts?: object): SpawnSyncReturns<string> => {
    callCount++;
    if (callCount === 1) {
      return { pid: 0, output: [], stdout: "1.0.0", stderr: "", status: 0, signal: null };
    }
    return {
      pid: 0,
      output: [],
      stdout: "not json",
      stderr: "",
      status: 0,
      signal: null,
    };
  };

  const result = checkClaudeCodeCli(mockSpawn as any);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not-authenticated");
  }
});
