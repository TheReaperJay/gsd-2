import test from "node:test";
import assert from "node:assert/strict";

import { Type } from "@sinclair/typebox";
import { z } from "zod";

import { typeboxToZodShape, wrapPromptAsAsyncIterable } from "../claude-code/mcp-tools.js";

// ─── typeboxToZodShape — primitive conversions ────────────────────────────────

test("typeboxToZodShape: Type.String with description produces z.string with description", () => {
  const schema = Type.Object({
    name: Type.String({ description: "The name field" }),
  });
  const shape = typeboxToZodShape(schema);
  assert.ok("name" in shape, "shape has 'name' key");
  const zodField = shape["name"];
  assert.ok(zodField instanceof z.ZodString, "field is ZodString");
  // Verify description is attached
  assert.equal(zodField.description, "The name field");
});

test("typeboxToZodShape: Type.Optional(Type.String) produces optional z.string with description", () => {
  const schema = Type.Object({
    tag: Type.Optional(Type.String({ description: "An optional tag" })),
  });
  const shape = typeboxToZodShape(schema);
  assert.ok("tag" in shape, "shape has 'tag' key");
  const zodField = shape["tag"];
  // Optional wraps with ZodOptional
  assert.ok(zodField instanceof z.ZodOptional, "field is ZodOptional");
  const inner = zodField.unwrap();
  assert.ok(inner instanceof z.ZodString, "inner type is ZodString");
  assert.equal(inner.description, "An optional tag");
});

test("typeboxToZodShape: required fields are ZodString, optional fields are ZodOptional", () => {
  const schema = Type.Object({
    required_field: Type.String({ description: "Required" }),
    optional_field: Type.Optional(Type.String({ description: "Optional" })),
  });
  const shape = typeboxToZodShape(schema);
  assert.ok(shape["required_field"] instanceof z.ZodString, "required field is ZodString");
  assert.ok(shape["optional_field"] instanceof z.ZodOptional, "optional field is ZodOptional");
});

// ─── typeboxToZodShape — gsd_save_decision schema ────────────────────────────

test("typeboxToZodShape: gsd_save_decision schema has 4 required and 2 optional fields", () => {
  const schema = Type.Object({
    scope: Type.String({ description: "Scope of the decision (e.g. 'architecture', 'library', 'observability')" }),
    decision: Type.String({ description: "What is being decided" }),
    choice: Type.String({ description: "The choice made" }),
    rationale: Type.String({ description: "Why this choice was made" }),
    revisable: Type.Optional(Type.String({ description: "Whether this can be revisited (default: 'Yes')" })),
    when_context: Type.Optional(Type.String({ description: "When/context for the decision (e.g. milestone ID)" })),
  });
  const shape = typeboxToZodShape(schema);

  // Required fields
  assert.ok(shape["scope"] instanceof z.ZodString, "scope is required ZodString");
  assert.ok(shape["decision"] instanceof z.ZodString, "decision is required ZodString");
  assert.ok(shape["choice"] instanceof z.ZodString, "choice is required ZodString");
  assert.ok(shape["rationale"] instanceof z.ZodString, "rationale is required ZodString");

  // Optional fields
  assert.ok(shape["revisable"] instanceof z.ZodOptional, "revisable is optional");
  assert.ok(shape["when_context"] instanceof z.ZodOptional, "when_context is optional");

  // Verify all 6 keys present
  const keys = Object.keys(shape);
  assert.equal(keys.length, 6, "shape has 6 keys");
});

// ─── typeboxToZodShape — gsd_update_requirement schema ───────────────────────

test("typeboxToZodShape: gsd_update_requirement schema has 1 required and 6 optional fields", () => {
  const schema = Type.Object({
    id: Type.String({ description: "The requirement ID (e.g. R001, R014)" }),
    status: Type.Optional(Type.String({ description: "New status (e.g. 'active', 'validated', 'deferred')" })),
    validation: Type.Optional(Type.String({ description: "Validation criteria or proof" })),
    notes: Type.Optional(Type.String({ description: "Additional notes" })),
    description: Type.Optional(Type.String({ description: "Updated description" })),
    primary_owner: Type.Optional(Type.String({ description: "Primary owning slice" })),
    supporting_slices: Type.Optional(Type.String({ description: "Supporting slices" })),
  });
  const shape = typeboxToZodShape(schema);

  // Required
  assert.ok(shape["id"] instanceof z.ZodString, "id is required ZodString");

  // Optional
  assert.ok(shape["status"] instanceof z.ZodOptional, "status is optional");
  assert.ok(shape["validation"] instanceof z.ZodOptional, "validation is optional");
  assert.ok(shape["notes"] instanceof z.ZodOptional, "notes is optional");
  assert.ok(shape["description"] instanceof z.ZodOptional, "description is optional");
  assert.ok(shape["primary_owner"] instanceof z.ZodOptional, "primary_owner is optional");
  assert.ok(shape["supporting_slices"] instanceof z.ZodOptional, "supporting_slices is optional");

  const keys = Object.keys(shape);
  assert.equal(keys.length, 7, "shape has 7 keys");
});

// ─── typeboxToZodShape — gsd_save_summary schema ─────────────────────────────

test("typeboxToZodShape: gsd_save_summary schema has 3 required and 2 optional fields", () => {
  const schema = Type.Object({
    milestone_id: Type.String({ description: "Milestone ID (e.g. M001)" }),
    slice_id: Type.Optional(Type.String({ description: "Slice ID (e.g. S01)" })),
    task_id: Type.Optional(Type.String({ description: "Task ID (e.g. T01)" })),
    artifact_type: Type.String({ description: "One of: SUMMARY, RESEARCH, CONTEXT, ASSESSMENT" }),
    content: Type.String({ description: "The full markdown content of the artifact" }),
  });
  const shape = typeboxToZodShape(schema);

  // Required
  assert.ok(shape["milestone_id"] instanceof z.ZodString, "milestone_id is required ZodString");
  assert.ok(shape["artifact_type"] instanceof z.ZodString, "artifact_type is required ZodString");
  assert.ok(shape["content"] instanceof z.ZodString, "content is required ZodString");

  // Optional
  assert.ok(shape["slice_id"] instanceof z.ZodOptional, "slice_id is optional");
  assert.ok(shape["task_id"] instanceof z.ZodOptional, "task_id is optional");

  const keys = Object.keys(shape);
  assert.equal(keys.length, 5, "shape has 5 keys");
});

// ─── typeboxToZodShape — description preservation ────────────────────────────

test("typeboxToZodShape: descriptions are preserved on required fields", () => {
  const schema = Type.Object({
    scope: Type.String({ description: "Scope of the decision" }),
  });
  const shape = typeboxToZodShape(schema);
  const field = shape["scope"] as z.ZodString;
  assert.equal(field.description, "Scope of the decision");
});

test("typeboxToZodShape: descriptions are preserved on optional fields", () => {
  const schema = Type.Object({
    revisable: Type.Optional(Type.String({ description: "Whether revisable" })),
  });
  const shape = typeboxToZodShape(schema);
  const field = shape["revisable"] as z.ZodOptional<z.ZodString>;
  const inner = field.unwrap();
  assert.equal(inner.description, "Whether revisable");
});

// ─── wrapPromptAsAsyncIterable ────────────────────────────────────────────────

test("wrapPromptAsAsyncIterable: yields exactly one message", async () => {
  const iterable = wrapPromptAsAsyncIterable("hello world");
  const messages: Array<{ role: string; content: string }> = [];
  for await (const msg of iterable) {
    messages.push(msg);
  }
  assert.equal(messages.length, 1, "yields exactly one message");
});

test("wrapPromptAsAsyncIterable: yielded message has role 'user'", async () => {
  const iterable = wrapPromptAsAsyncIterable("test prompt");
  const messages: Array<{ role: string; content: string }> = [];
  for await (const msg of iterable) {
    messages.push(msg);
  }
  assert.equal(messages[0]!.role, "user");
});

test("wrapPromptAsAsyncIterable: yielded message content matches input prompt", async () => {
  const prompt = "execute this task";
  const iterable = wrapPromptAsAsyncIterable(prompt);
  const messages: Array<{ role: string; content: string }> = [];
  for await (const msg of iterable) {
    messages.push(msg);
  }
  assert.equal(messages[0]!.content, prompt);
});

// ─── createGsdMcpServer — structural verification ────────────────────────────

test("createGsdMcpServer is exported as an async function", async () => {
  const module = await import("../claude-code/mcp-tools.js");
  assert.ok("createGsdMcpServer" in module, "createGsdMcpServer is exported");
  assert.equal(typeof module.createGsdMcpServer, "function");
  // Verify it returns a promise (async function)
  const result = module.createGsdMcpServer();
  assert.ok(result instanceof Promise, "createGsdMcpServer returns a Promise");
  // Don't await it — would require SDK to be installed
  // Swallow any rejection from missing SDK
  result.catch(() => {});
});
