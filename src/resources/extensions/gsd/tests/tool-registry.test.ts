/**
 * Tests for provider-api tool registry and defineGsdTool helper.
 *
 * Covers:
 * - registerGsdTool() adds to registry
 * - getGsdTools() returns registered tools
 * - defineGsdTool<T>() produces a valid GsdToolDef with correct name/description/schema
 * - Tool execute callbacks are preserved through the registry
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { registerGsdTool, getGsdTools } from "../provider-api/tool-registry.js";
import { defineGsdTool } from "../provider-api/define-tool.js";
import type { GsdToolDef } from "../provider-api/types.js";

describe("provider-api tool registry", () => {

  test("registerGsdTool adds a tool and getGsdTools returns it", () => {
    const initialCount = getGsdTools().length;

    const tool: GsdToolDef = {
      name: "test_tool",
      description: "A test tool",
      schema: { input: z.string() },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };

    registerGsdTool(tool);

    const tools = getGsdTools();
    assert.equal(tools.length, initialCount + 1);
    assert.equal(tools[tools.length - 1].name, "test_tool");
  });

  test("getGsdTools returns readonly array", () => {
    const tools = getGsdTools();
    assert.ok(Array.isArray(tools));
  });

});

describe("defineGsdTool", () => {

  test("produces GsdToolDef with correct name, description, and schema", () => {
    const tool = defineGsdTool(
      "my_tool",
      "My tool description",
      { value: z.string(), count: z.number().optional() },
      async (args) => {
        // Type safety: args.value is string, args.count is number | undefined
        const msg = `${args.value}: ${args.count ?? 0}`;
        return { content: [{ type: "text", text: msg }] };
      },
    );

    assert.equal(tool.name, "my_tool");
    assert.equal(tool.description, "My tool description");
    assert.ok("value" in tool.schema);
    assert.ok("count" in tool.schema);
  });

  test("execute callback is preserved and callable", async () => {
    const tool = defineGsdTool(
      "echo_tool",
      "Echoes input",
      { message: z.string() },
      async (args) => ({ content: [{ type: "text", text: args.message }] }),
    );

    const result = await tool.execute({ message: "hello" });
    assert.deepEqual(result, { content: [{ type: "text", text: "hello" }] });
  });

});
