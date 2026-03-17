import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  resolveClaudeCodeAlias,
  getSdkTierConfig,
  getDowngradeStep,
  getEscalationStep,
  DOWNGRADE_LADDER,
  ESCALATION_LADDER,
} from "../claude-code/models-resolver.js";

// ─── resolveClaudeCodeAlias ───────────────────────────────────────────────────

describe("resolveClaudeCodeAlias", () => {
  test("claude-opus-4-6 resolves to opus", () => {
    assert.equal(resolveClaudeCodeAlias("claude-opus-4-6"), "opus");
  });

  test("claude-3-opus-latest resolves to opus", () => {
    assert.equal(resolveClaudeCodeAlias("claude-3-opus-latest"), "opus");
  });

  test("claude-sonnet-4-6 resolves to sonnet", () => {
    assert.equal(resolveClaudeCodeAlias("claude-sonnet-4-6"), "sonnet");
  });

  test("claude-sonnet-4-5-20250514 resolves to sonnet", () => {
    assert.equal(resolveClaudeCodeAlias("claude-sonnet-4-5-20250514"), "sonnet");
  });

  test("claude-haiku-4-5 resolves to haiku", () => {
    assert.equal(resolveClaudeCodeAlias("claude-haiku-4-5"), "haiku");
  });

  test("claude-3-5-haiku-latest resolves to haiku", () => {
    assert.equal(resolveClaudeCodeAlias("claude-3-5-haiku-latest"), "haiku");
  });

  test("unknown-model falls back to sonnet (safe default)", () => {
    assert.equal(resolveClaudeCodeAlias("unknown-model"), "sonnet");
  });
});

// ─── getSdkTierConfig ─────────────────────────────────────────────────────────

describe("getSdkTierConfig", () => {
  test("light tier returns haiku + low effort + disabled thinking", () => {
    const cfg = getSdkTierConfig("light");
    assert.deepEqual(cfg, {
      model: "haiku",
      effort: "low",
      thinking: { type: "disabled" },
    });
  });

  test("standard tier returns sonnet + medium effort + enabled thinking", () => {
    const cfg = getSdkTierConfig("standard");
    assert.deepEqual(cfg, {
      model: "sonnet",
      effort: "medium",
      thinking: { type: "enabled" },
    });
  });

  test("heavy tier returns opus + high effort + enabled thinking", () => {
    const cfg = getSdkTierConfig("heavy");
    assert.deepEqual(cfg, {
      model: "opus",
      effort: "high",
      thinking: { type: "enabled" },
    });
  });
});

// ─── DOWNGRADE_LADDER ─────────────────────────────────────────────────────────

describe("DOWNGRADE_LADDER", () => {
  test("has exactly 6 entries", () => {
    assert.equal(DOWNGRADE_LADDER.length, 6);
  });

  test("index 0 is opus+high+enabled (start for heavy tier)", () => {
    assert.deepEqual(DOWNGRADE_LADDER[0], {
      model: "opus",
      effort: "high",
      thinking: { type: "enabled" },
    });
  });

  test("index 1 is opus+medium+enabled", () => {
    assert.deepEqual(DOWNGRADE_LADDER[1], {
      model: "opus",
      effort: "medium",
      thinking: { type: "enabled" },
    });
  });

  test("index 2 is opus+low+disabled", () => {
    assert.deepEqual(DOWNGRADE_LADDER[2], {
      model: "opus",
      effort: "low",
      thinking: { type: "disabled" },
    });
  });

  test("index 3 is sonnet+medium+enabled", () => {
    assert.deepEqual(DOWNGRADE_LADDER[3], {
      model: "sonnet",
      effort: "medium",
      thinking: { type: "enabled" },
    });
  });

  test("index 4 is sonnet+low+disabled", () => {
    assert.deepEqual(DOWNGRADE_LADDER[4], {
      model: "sonnet",
      effort: "low",
      thinking: { type: "disabled" },
    });
  });

  test("index 5 is haiku+low+disabled (floor)", () => {
    assert.deepEqual(DOWNGRADE_LADDER[5], {
      model: "haiku",
      effort: "low",
      thinking: { type: "disabled" },
    });
  });

  test("no entry uses effort 'max'", () => {
    for (const entry of DOWNGRADE_LADDER) {
      assert.notEqual(entry.effort, "max");
    }
  });
});

// ─── ESCALATION_LADDER ────────────────────────────────────────────────────────

describe("ESCALATION_LADDER", () => {
  test("has exactly 3 entries", () => {
    assert.equal(ESCALATION_LADDER.length, 3);
  });

  test("index 0 is sonnet+medium+enabled (start)", () => {
    assert.deepEqual(ESCALATION_LADDER[0], {
      model: "sonnet",
      effort: "medium",
      thinking: { type: "enabled" },
    });
  });

  test("index 1 is sonnet+high+enabled", () => {
    assert.deepEqual(ESCALATION_LADDER[1], {
      model: "sonnet",
      effort: "high",
      thinking: { type: "enabled" },
    });
  });

  test("index 2 is opus+high+enabled (ceiling)", () => {
    assert.deepEqual(ESCALATION_LADDER[2], {
      model: "opus",
      effort: "high",
      thinking: { type: "enabled" },
    });
  });

  test("no entry uses effort 'max'", () => {
    for (const entry of ESCALATION_LADDER) {
      assert.notEqual(entry.effort, "max");
    }
  });
});

// ─── getDowngradeStep ─────────────────────────────────────────────────────────

describe("getDowngradeStep", () => {
  test("getDowngradeStep(0) returns 1 (opus+medium)", () => {
    assert.equal(getDowngradeStep(0), 1);
  });

  test("getDowngradeStep(3) returns 4 (sonnet+low)", () => {
    assert.equal(getDowngradeStep(3), 4);
  });

  test("getDowngradeStep(4) returns 5 (haiku+low — floor approach)", () => {
    assert.equal(getDowngradeStep(4), 5);
  });

  test("getDowngradeStep(5) returns null (already at floor)", () => {
    assert.equal(getDowngradeStep(5), null);
  });
});

// ─── getEscalationStep ────────────────────────────────────────────────────────

describe("getEscalationStep", () => {
  test("getEscalationStep(0) returns 1 (sonnet+high)", () => {
    assert.equal(getEscalationStep(0), 1);
  });

  test("getEscalationStep(1) returns 2 (opus+high)", () => {
    assert.equal(getEscalationStep(1), 2);
  });

  test("getEscalationStep(2) returns null (already at ceiling)", () => {
    assert.equal(getEscalationStep(2), null);
  });
});
