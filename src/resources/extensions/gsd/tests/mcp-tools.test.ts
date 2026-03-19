import test from "node:test";
import assert from "node:assert/strict";

import { wrapPromptAsAsyncIterable } from "../claude-code/mcp-tools.js";

// ─── wrapPromptAsAsyncIterable ────────────────────────────────────────────────

test("wrapPromptAsAsyncIterable: yields exactly one message", async () => {
  const iterable = wrapPromptAsAsyncIterable("hello world");
  const messages: unknown[] = [];
  for await (const msg of iterable) {
    messages.push(msg);
  }
  assert.equal(messages.length, 1, "yields exactly one message");
});

test("wrapPromptAsAsyncIterable: yielded message has role 'user'", async () => {
  const iterable = wrapPromptAsAsyncIterable("test prompt");
  const messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
  for await (const msg of iterable) {
    messages.push(msg);
  }
  assert.equal(messages[0]!.role, "user");
});

test("wrapPromptAsAsyncIterable: yielded message content contains prompt text", async () => {
  const prompt = "execute this task";
  const iterable = wrapPromptAsAsyncIterable(prompt);
  const messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
  for await (const msg of iterable) {
    messages.push(msg);
  }
  assert.equal(messages[0]!.content[0]!.type, "text");
  assert.equal(messages[0]!.content[0]!.text, prompt);
});

// ─── createGsdMcpServer — structural verification ────────────────────────────

test("createGsdMcpServer is exported as an async function", async () => {
  const module = await import("../claude-code/mcp-tools.js");
  assert.ok("createGsdMcpServer" in module, "createGsdMcpServer is exported");
  assert.equal(typeof module.createGsdMcpServer, "function");
  const result = module.createGsdMcpServer();
  assert.ok(result instanceof Promise, "createGsdMcpServer returns a Promise");
  result.catch(() => {});
});
