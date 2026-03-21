import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { Api, Model, Context, AssistantMessageEvent } from "@gsd/pi-ai";
import type { AssistantMessageEventStream } from "@gsd/pi-ai";
import type { GsdProviderInfo, GsdEvent, GsdEventStream, GsdProviderDeps } from "../types.js";
import { wireProvidersToPI } from "../adapter.js";
import { registerProviderInfo, setProviderDeps } from "../provider-registry.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockPi(): {
  pi: ExtensionAPI;
  registered: Map<string, unknown>;
  get agentStartHandler(): ((_event: unknown, ctx: ExtensionContext) => Promise<void>) | null;
  get agentEndHandler(): (() => Promise<void>) | null;
} {
  const registered = new Map<string, unknown>();
  let _agentStartHandler: ((_event: unknown, ctx: ExtensionContext) => Promise<void>) | null = null;
  let _agentEndHandler: (() => Promise<void>) | null = null;

  const pi = {
    registerProvider: (id: string, config: unknown) => { registered.set(id, config); },
    on: (event: string, handler: unknown) => {
      if (event === "agent_start") _agentStartHandler = handler as typeof _agentStartHandler;
      if (event === "agent_end") _agentEndHandler = handler as typeof _agentEndHandler;
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    registered,
    get agentStartHandler() { return _agentStartHandler; },
    get agentEndHandler() { return _agentEndHandler; },
  };
}

function makeTestProvider(id: string, events: GsdEvent[]): GsdProviderInfo {
  return {
    id,
    displayName: `Test Provider ${id}`,
    auth: { type: "none", reason: "test only" },
    models: [{ id: `${id}:test-model`, displayName: "Test Model", reasoning: false, contextWindow: 200000, maxTokens: 32000 }],
    createStream: (_context, _deps): GsdEventStream => {
      return (async function* () { for (const e of events) yield e; })();
    },
  };
}

function createMockDeps(): GsdProviderDeps {
  return {
    getSupervisorConfig: () => ({}),
    shouldBlockContextWrite: () => ({ block: false }),
    getMilestoneId: () => null,
    isDepthVerified: () => true,
    getIsUnitDone: () => false,
    onToolStart: () => {},
    onToolEnd: () => {},
    getBasePath: () => "/test/project",
    getUnitInfo: () => ({ unitType: "execute-task", unitId: "test-unit" }),
  };
}

function makeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "test-provider:test-model",
    name: "Test Model",
    api: "anthropic-messages" as Api,
    provider: "test-provider",
    baseUrl: "test-provider:",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32000,
    ...overrides,
  };
}

function makeContext(overrides?: Partial<Context>): Context {
  return {
    systemPrompt: "You are a test agent.",
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    ...overrides,
  };
}

async function collectEvents(
  stream: AssistantMessageEventStream,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "done" || event.type === "error") break;
  }
  return events;
}

async function runEvents(events: GsdEvent[]): Promise<AssistantMessageEvent[]> {
  const id = `trans-stub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  registerProviderInfo(makeTestProvider(id, events));
  setProviderDeps(createMockDeps());
  const { pi, registered } = makeMockPi();
  await wireProvidersToPI(pi);
  const config = registered.get(id) as Record<string, unknown>;
  const streamSimple = config["streamSimple"] as (model: Model<Api>, context: Context) => AssistantMessageEventStream;
  const stream = streamSimple(makeModel({ id: `${id}:test-model`, provider: id }), makeContext());
  return collectEvents(stream);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("stream translation", () => {
  describe("stream translation", () => {
    it("translates text_delta GsdEvent to Pi text_start + text_delta events", async () => {
      const events = await runEvents([
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
        { type: "completion", usage: { inputTokens: 10, outputTokens: 5 }, stopReason: "stop" },
      ]);

      const startEvent = events.find(e => e.type === "start");
      assert.ok(startEvent, "start event must be emitted");

      const textStartEvent = events.find(e => e.type === "text_start");
      assert.ok(textStartEvent, "text_start must be synthesized before first text_delta");

      const textDeltas = events.filter(e => e.type === "text_delta");
      assert.equal(textDeltas.length, 2, "both text_delta events must be forwarded");

      const textEndEvent = events.find(e => e.type === "text_end");
      assert.ok(textEndEvent, "text_end must be emitted on completion");
    });
  });

  describe("completion event translation", () => {
    it("translates completion GsdEvent to Pi text_end + done events with usage", async () => {
      const events = await runEvents([
        { type: "text_delta", text: "result" },
        { type: "completion", usage: { inputTokens: 100, outputTokens: 50 }, stopReason: "stop" },
      ]);

      const textEnd = events.find(e => e.type === "text_end");
      assert.ok(textEnd, "text_end must be emitted before done");

      const doneEvent = events.find(e => e.type === "done") as ({ type: "done"; message: { usage: { input: number; output: number; totalTokens: number } } } | undefined);
      assert.ok(doneEvent, "done event must be emitted");
      assert.equal(doneEvent.message.usage.input, 100, "input tokens must be 100");
      assert.equal(doneEvent.message.usage.output, 50, "output tokens must be 50");
      assert.equal(doneEvent.message.usage.totalTokens, 150, "totalTokens must be sum of input + output");
    });
  });

  describe("error event translation", () => {
    it("translates error GsdEvent to Pi error event with stop reason", async () => {
      const events = await runEvents([
        { type: "error", message: "rate limited", category: "rate_limit" as const },
      ]);

      const errorEvent = events.find(e => e.type === "error") as ({ type: "error"; error: { stopReason: string; errorMessage: string } } | undefined);
      assert.ok(errorEvent, "error event must be emitted");
      assert.equal(errorEvent.error.stopReason, "error", "stop reason must be 'error'");
      assert.equal(errorEvent.error.errorMessage, "rate limited", "error message must match GsdEvent error message");
    });
  });
});
