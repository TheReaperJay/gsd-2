/**
 * Tests for runPluginOnboarding() — the default plugin onboarding function.
 *
 * Covers:
 * - CLI auth provider succeeds: returns { ok: true }, stores credential
 * - CLI auth provider fails: returns { ok: false }, does NOT store credential
 * - Custom onboard() function: called and result wrapped in { ok: result }
 * - defaultModel + settingsManager: setDefaultModelAndProvider called on success
 * - No settingsManager: does not throw when defaultModel is set but settingsManager absent
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import type { GsdProviderInfo } from '@gsd/provider-api'

// ─── Mock Factories ───────────────────────────────────────────────────────────

type MockClack = {
  spinner: () => { start: (msg: string) => void; stop: (msg: string) => void }
  log: { warn: (msg: string) => void }
}

type MockPico = {
  green: (s: string) => string
  cyan: (s: string) => string
  yellow: (s: string) => string
  dim: (s: string) => string
  bold: (s: string) => string
  red: (s: string) => string
  reset: (s: string) => string
}

type MockAuthStorage = {
  set: (id: string, credential: unknown) => void
  calls: Array<{ id: string; credential: unknown }>
}

type MockSettingsManager = {
  setDefaultModelAndProvider: (providerId: string, modelId: string) => void
  calls: Array<{ providerId: string; modelId: string }>
}

function makeClack(): MockClack {
  return {
    spinner: () => ({
      start: (_msg: string) => undefined,
      stop: (_msg: string) => undefined,
    }),
    log: {
      warn: (_msg: string) => undefined,
    },
  }
}

function makePico(): MockPico {
  return {
    green: (s: string) => s,
    cyan: (s: string) => s,
    yellow: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    red: (s: string) => s,
    reset: (s: string) => s,
  }
}

function makeAuthStorage(): MockAuthStorage {
  const storage: MockAuthStorage = {
    calls: [],
    set(id: string, credential: unknown) {
      storage.calls.push({ id, credential })
    },
  }
  return storage
}

function makeSettingsManager(): MockSettingsManager {
  const mgr: MockSettingsManager = {
    calls: [],
    setDefaultModelAndProvider(providerId: string, modelId: string) {
      mgr.calls.push({ providerId, modelId })
    },
  }
  return mgr
}

// ─── Mock Provider Factories ──────────────────────────────────────────────────

function makeCliProvider(checkResult: { ok: true; email?: string } | { ok: false; reason: string; instruction: string }): GsdProviderInfo {
  return {
    id: 'test-provider',
    displayName: 'Test Provider',
    auth: {
      type: 'cli',
      hint: 'requires test-cli installed and logged in',
      check: () => checkResult as ReturnType<NonNullable<Extract<GsdProviderInfo['auth'], { type: 'cli' }>['check']>>,
      credential: { type: 'api_key', key: 'test-cli-credential' },
    },
    models: [{ id: 'test-provider:model-1', displayName: 'Model 1', costPer1KInput: 0, costPer1KOutput: 0, contextWindow: 100000 }],
    defaultModel: 'test-provider:model-1',
    createStream: () => { throw new Error('not used in tests') },
  }
}

function makeCustomOnboardProvider(onboardResult: boolean): GsdProviderInfo {
  return {
    id: 'custom-provider',
    displayName: 'Custom',
    auth: {
      type: 'none',
      reason: 'custom onboard handles auth',
    },
    models: [],
    onboard: async (_p, _pc, _authStorage) => onboardResult,
    createStream: () => { throw new Error('not used in tests') },
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('runPluginOnboarding: CLI auth ok=true returns { ok: true } and stores credential', async () => {
  const { runPluginOnboarding } = await import('@gsd/provider-api')
  const pp = makeCliProvider({ ok: true, email: 'test@example.com' })
  const p = makeClack()
  const pc = makePico()
  const authStorage = makeAuthStorage()

  const result = await runPluginOnboarding(pp, p as unknown as typeof import('@clack/prompts'), pc, authStorage)

  assert.deepEqual(result, { ok: true })
  assert.equal(authStorage.calls.length, 1)
  assert.equal(authStorage.calls[0]!.id, 'test-provider')
  assert.deepEqual(authStorage.calls[0]!.credential, { type: 'api_key', key: 'test-cli-credential' })
})

test('runPluginOnboarding: CLI auth ok=false returns { ok: false } and does NOT store credential', async () => {
  const { runPluginOnboarding } = await import('@gsd/provider-api')
  const pp = makeCliProvider({ ok: false, reason: 'Not logged in', instruction: 'Run test-cli login' })
  const p = makeClack()
  const pc = makePico()
  const authStorage = makeAuthStorage()

  const result = await runPluginOnboarding(pp, p as unknown as typeof import('@clack/prompts'), pc, authStorage)

  assert.deepEqual(result, { ok: false })
  assert.equal(authStorage.calls.length, 0)
})

test('runPluginOnboarding: custom onboard() is called and result wrapped in { ok }', async () => {
  const { runPluginOnboarding } = await import('@gsd/provider-api')
  const pp = makeCustomOnboardProvider(true)
  const p = makeClack()
  const pc = makePico()
  const authStorage = makeAuthStorage()

  const result = await runPluginOnboarding(pp, p as unknown as typeof import('@clack/prompts'), pc, authStorage)

  assert.deepEqual(result, { ok: true })
})

test('runPluginOnboarding: CLI auth ok=true with defaultModel + settingsManager calls setDefaultModelAndProvider', async () => {
  const { runPluginOnboarding } = await import('@gsd/provider-api')
  const pp = makeCliProvider({ ok: true, email: 'test@example.com' })
  const p = makeClack()
  const pc = makePico()
  const authStorage = makeAuthStorage()
  const settingsManager = makeSettingsManager()

  await runPluginOnboarding(pp, p as unknown as typeof import('@clack/prompts'), pc, authStorage, settingsManager)

  assert.equal(settingsManager.calls.length, 1)
  assert.equal(settingsManager.calls[0]!.providerId, 'test-provider')
  assert.equal(settingsManager.calls[0]!.modelId, 'test-provider:model-1')
})

test('runPluginOnboarding: CLI auth ok=true with no settingsManager does NOT throw', async () => {
  const { runPluginOnboarding } = await import('@gsd/provider-api')
  const pp = makeCliProvider({ ok: true, email: 'test@example.com' })
  const p = makeClack()
  const pc = makePico()
  const authStorage = makeAuthStorage()

  // No settingsManager passed — must not throw
  await assert.doesNotReject(async () => {
    const result = await runPluginOnboarding(pp, p as unknown as typeof import('@clack/prompts'), pc, authStorage)
    assert.deepEqual(result, { ok: true })
  })
})
