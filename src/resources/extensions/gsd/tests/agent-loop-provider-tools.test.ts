/**
 * Unit tests for agent loop provider tool event handling.
 *
 * Verifies that provider_tool_start and provider_tool_end events on the
 * AssistantMessageEventStream are translated to tool_execution_start and
 * tool_execution_end AgentEvents by the agent loop. The partial message must
 * NOT be updated by these events (no message_update emitted for them).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { agentLoop } from "@gsd/pi-agent-core";
import { AssistantMessageEventStream } from "@gsd/pi-ai";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  StreamFn,
} from "@gsd/pi-agent-core";
import type { AssistantMessage, Model } from "@gsd/pi-ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(): Model<"anthropic"> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "anthropic",
    provider: "anthropic",
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function makeAssistantMessage(model: Model<"anthropic">): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeConfig(model: Model<"anthropic">): AgentLoopConfig {
  return {
    model,
    convertToLlm: (messages: AgentMessage[]) =>
      messages.filter(
        (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
      ),
  };
}

function makeContext(): AgentContext {
  return {
    systemPrompt: "You are a test assistant.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: Date.now() },
    ],
  };
}

/**
 * Collect all AgentEvents from the agent loop stream until agent_end.
 */
async function collectEvents(
  stream: ReturnType<typeof agentLoop>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "agent_end") break;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("provider_tool_start event produces tool_execution_start AgentEvent", async () => {
  const model = makeModel();
  const finalMessage = makeAssistantMessage(model);

  const streamFn: StreamFn = async () => {
    const mockStream = new AssistantMessageEventStream();
    mockStream.push({ type: "start", partial: { ...finalMessage, content: [] } });
    mockStream.push({
      type: "provider_tool_start",
      toolCallId: "call-123",
      toolName: "bash",
      args: { command: "ls" },
    });
    mockStream.push({ type: "done", reason: "stop", message: finalMessage });
    return mockStream;
  };

  const context = makeContext();
  const config = makeConfig(model);
  const loop = agentLoop([], context, config, undefined, streamFn);

  const events = await collectEvents(loop);

  const startEvent = events.find((e) => e.type === "tool_execution_start") as
    | Extract<AgentEvent, { type: "tool_execution_start" }>
    | undefined;

  assert.ok(startEvent, "tool_execution_start event should be emitted");
  assert.equal(startEvent.toolCallId, "call-123");
  assert.equal(startEvent.toolName, "bash");
  assert.deepEqual(startEvent.args, { command: "ls" });
});

test("provider_tool_end event produces tool_execution_end AgentEvent", async () => {
  const model = makeModel();
  const finalMessage = makeAssistantMessage(model);

  const streamFn: StreamFn = async () => {
    const mockStream = new AssistantMessageEventStream();
    mockStream.push({ type: "start", partial: { ...finalMessage, content: [] } });
    mockStream.push({
      type: "provider_tool_end",
      toolCallId: "call-456",
      toolName: "read_file",
      result: { content: "file contents" },
      isError: false,
    });
    mockStream.push({ type: "done", reason: "stop", message: finalMessage });
    return mockStream;
  };

  const context = makeContext();
  const config = makeConfig(model);
  const loop = agentLoop([], context, config, undefined, streamFn);

  const events = await collectEvents(loop);

  const endEvent = events.find((e) => e.type === "tool_execution_end") as
    | Extract<AgentEvent, { type: "tool_execution_end" }>
    | undefined;

  assert.ok(endEvent, "tool_execution_end event should be emitted");
  assert.equal(endEvent.toolCallId, "call-456");
  assert.equal(endEvent.toolName, "read_file");
  assert.deepEqual(endEvent.result, { content: "file contents" });
  assert.equal(endEvent.isError, false);
});

test("provider_tool events do not emit message_update", async () => {
  const model = makeModel();
  const finalMessage = makeAssistantMessage(model);

  const streamFn: StreamFn = async () => {
    const mockStream = new AssistantMessageEventStream();
    mockStream.push({ type: "start", partial: { ...finalMessage, content: [] } });
    mockStream.push({
      type: "provider_tool_start",
      toolCallId: "call-789",
      toolName: "list_files",
      args: {},
    });
    mockStream.push({
      type: "provider_tool_end",
      toolCallId: "call-789",
      toolName: "list_files",
      result: ["file1.ts", "file2.ts"],
      isError: false,
    });
    mockStream.push({ type: "done", reason: "stop", message: finalMessage });
    return mockStream;
  };

  const context = makeContext();
  const config = makeConfig(model);
  const loop = agentLoop([], context, config, undefined, streamFn);

  const events = await collectEvents(loop);

  const messageUpdates = events.filter((e) => e.type === "message_update");
  assert.equal(
    messageUpdates.length,
    0,
    "provider_tool events must not emit message_update AgentEvents",
  );
});

test("provider tool events can appear between start and done without breaking stream", async () => {
  const model = makeModel();
  const finalMessage = makeAssistantMessage(model);

  const streamFn: StreamFn = async () => {
    const mockStream = new AssistantMessageEventStream();
    mockStream.push({ type: "start", partial: { ...finalMessage, content: [] } });
    mockStream.push({
      type: "provider_tool_start",
      toolCallId: "call-aaa",
      toolName: "tool_a",
      args: { x: 1 },
    });
    mockStream.push({
      type: "provider_tool_end",
      toolCallId: "call-aaa",
      toolName: "tool_a",
      result: "ok",
      isError: false,
    });
    mockStream.push({
      type: "provider_tool_start",
      toolCallId: "call-bbb",
      toolName: "tool_b",
      args: { y: 2 },
    });
    mockStream.push({
      type: "provider_tool_end",
      toolCallId: "call-bbb",
      toolName: "tool_b",
      result: null,
      isError: true,
    });
    mockStream.push({ type: "done", reason: "stop", message: finalMessage });
    return mockStream;
  };

  const context = makeContext();
  const config = makeConfig(model);
  const loop = agentLoop([], context, config, undefined, streamFn);

  const events = await collectEvents(loop);

  // Stream completes without error
  assert.ok(events.some((e) => e.type === "agent_end"), "agent_end should be emitted");

  // Two pairs of tool execution events
  const startEvents = events.filter((e) => e.type === "tool_execution_start");
  const endEvents = events.filter((e) => e.type === "tool_execution_end");
  assert.equal(startEvents.length, 2, "two tool_execution_start events expected");
  assert.equal(endEvents.length, 2, "two tool_execution_end events expected");

  // Second end event has isError: true
  const errEvent = endEvents.find(
    (e) =>
      (e as Extract<AgentEvent, { type: "tool_execution_end" }>).isError === true,
  );
  assert.ok(errEvent, "one tool_execution_end should have isError: true");
});
