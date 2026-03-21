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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("adapter", () => {
  describe("wireProvidersToPI", () => {
    it("calls pi.registerProvider for each registered provider info", () => {
      const id = `wire-stub-${Date.now()}`;
      registerProviderInfo(makeTestProvider(id, []));
      const { pi, registered } = makeMockPi();
      wireProvidersToPI(pi);
      assert.ok(registered.has(id), `pi.registerProvider must be called for provider "${id}"`);
    });
  });

  describe("provider registration model shape", () => {
    it("maps GsdModel fields to ProviderModelConfig correctly", () => {
      const id = `shape-stub-${Date.now()}`;
      registerProviderInfo(makeTestProvider(id, []));
      const { pi, registered } = makeMockPi();
      wireProvidersToPI(pi);
      const config = registered.get(id) as Record<string, unknown>;
      assert.ok(config, "registered config must exist");
      assert.equal(config["api"], id, "api field must equal provider id");
      assert.equal(config["baseUrl"], `${id}:`, "baseUrl must be {id}:");
      assert.equal(typeof config["streamSimple"], "function", "streamSimple must be a function");
      const models = config["models"] as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(models), "models must be an array");
      assert.equal(models[0]["id"], `${id}:test-model`);
      assert.equal(models[0]["reasoning"], false);
      assert.equal(models[0]["contextWindow"], 200000);
      assert.equal(models[0]["maxTokens"], 32000);
    });
  });

  describe("TUI tool status", () => {
    it("sets TUI status on tool_start event with detail", async () => {
      const id = `tui-stub-${Date.now()}`;
      registerProviderInfo(makeTestProvider(id, [
        { type: "tool_start", toolCallId: "c1", toolName: "Bash", detail: "ls -la" },
        { type: "tool_end", toolCallId: "c1" },
        { type: "completion", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" },
      ]));
      setProviderDeps(createMockDeps());

      const statusCalls: Array<{ key: string; text: string | undefined }> = [];
      const mockCtx = {
        ui: { setStatus: (key: string, text: string | undefined) => { statusCalls.push({ key, text }); } },
      } as unknown as ExtensionContext;

      type AgentStartFn = (_event: unknown, ctx: ExtensionContext) => Promise<void>;
      type StreamSimpleFn = (model: Model<Api>, context: Context) => AssistantMessageEventStream;
      const captured: { start: AgentStartFn | null; stream: StreamSimpleFn | null } = { start: null, stream: null };

      const pi = {
        registerProvider: (pid: string, cfg: unknown) => {
          if (pid === id) captured.stream = (cfg as Record<string, StreamSimpleFn>)["streamSimple"];
        },
        on: (event: string, handler: unknown) => {
          if (event === "agent_start") captured.start = handler as AgentStartFn;
        },
      } as unknown as ExtensionAPI;

      wireProvidersToPI(pi);

      if (captured.start) await captured.start({}, mockCtx);
      assert.ok(captured.stream, "streamSimple must be captured");

      const stream = captured.stream(makeModel({ id: `${id}:test-model`, provider: id }), makeContext());
      await collectEvents(stream);

      const setCall = statusCalls.find(c => c.text !== undefined);
      assert.ok(setCall, "ctx.ui.setStatus must be called on tool_start");
      assert.ok(setCall.text!.includes("bash"), "status text must include tool name");
      assert.ok(setCall.text!.includes("ls -la"), "status text must include detail");
    });
  });

  describe("TUI tool status clear", () => {
    it("clears TUI status on tool_end event", async () => {
      const id = `tui-clear-stub-${Date.now()}`;
      registerProviderInfo(makeTestProvider(id, [
        { type: "tool_start", toolCallId: "c1", toolName: "Read" },
        { type: "tool_end", toolCallId: "c1" },
        { type: "completion", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" },
      ]));
      setProviderDeps(createMockDeps());

      const statusCalls: Array<{ key: string; text: string | undefined }> = [];
      const mockCtx = {
        ui: { setStatus: (key: string, text: string | undefined) => { statusCalls.push({ key, text }); } },
      } as unknown as ExtensionContext;

      type AgentStartFn = (_event: unknown, ctx: ExtensionContext) => Promise<void>;
      type StreamSimpleFn = (model: Model<Api>, context: Context) => AssistantMessageEventStream;
      const captured: { start: AgentStartFn | null; stream: StreamSimpleFn | null } = { start: null, stream: null };

      const pi = {
        registerProvider: (pid: string, cfg: unknown) => {
          if (pid === id) captured.stream = (cfg as Record<string, StreamSimpleFn>)["streamSimple"];
        },
        on: (event: string, handler: unknown) => {
          if (event === "agent_start") captured.start = handler as AgentStartFn;
        },
      } as unknown as ExtensionAPI;

      wireProvidersToPI(pi);
      if (captured.start) await captured.start({}, mockCtx);
      assert.ok(captured.stream, "streamSimple must be captured");

      const stream = captured.stream(makeModel({ id: `${id}:test-model`, provider: id }), makeContext());
      await collectEvents(stream);

      const clearCall = statusCalls.find(c => c.text === undefined);
      assert.ok(clearCall, "ctx.ui.setStatus must be called with undefined on tool_end (clears status)");
      assert.equal(clearCall.key, `${id}-tool`, "clear call key must be {provider-id}-tool");
    });
  });

  describe("tool events not forwarded", () => {
    it("does not push tool_start or tool_end to Pi stream", async () => {
      const id = `no-fwd-stub-${Date.now()}`;
      registerProviderInfo(makeTestProvider(id, [
        { type: "tool_start", toolCallId: "c1", toolName: "Bash" },
        { type: "text_delta", text: "output" },
        { type: "tool_end", toolCallId: "c1" },
        { type: "completion", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" },
      ]));
      setProviderDeps(createMockDeps());

      const { pi, registered } = makeMockPi();
      wireProvidersToPI(pi);

      const config = registered.get(id) as Record<string, unknown>;
      const streamSimple = config["streamSimple"] as (model: Model<Api>, context: Context) => AssistantMessageEventStream;
      const stream = streamSimple(makeModel({ id: `${id}:test-model`, provider: id }), makeContext());
      const events = await collectEvents(stream);

      const rawEvents = events as Array<{ type: string }>;
      assert.ok(!rawEvents.some(e => e.type === "tool_start"), "tool_start must NOT appear in Pi stream");
      assert.ok(!rawEvents.some(e => e.type === "tool_end"), "tool_end must NOT appear in Pi stream");
    });
  });
});
