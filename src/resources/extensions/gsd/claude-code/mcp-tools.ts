/**
 * GSD MCP Tools — SDK tool registration via createSdkMcpServer
 *
 * Registers GSD's 3 custom tools (gsd_save_decision, gsd_update_requirement,
 * gsd_save_summary) with the Claude Agent SDK's in-process MCP server.
 *
 * TypeBox is the single source of truth for the 3 GSD tool schemas. This
 * module converts them to Zod shapes at registration time via typeboxToZodShape(),
 * avoiding duplicate schema definitions.
 *
 * The SDK dependency is loaded via dynamic import() — it is an optional
 * dependency that is never loaded unless the claude-code provider is in use.
 *
 * Exports:
 * - typeboxToZodShape() — converts TObject to a raw Zod shape
 * - wrapPromptAsAsyncIterable() — wraps a prompt string as AsyncIterable<SDKUserMessage>
 * - createGsdMcpServer() — creates and returns the in-process MCP server config
 */

import { z } from "zod";
import { Type, type TObject } from "@sinclair/typebox";

// ─── TypeBox-to-Zod conversion ─────────────────────────────────────────────

/**
 * Convert a TypeBox TObject schema to a raw Zod shape compatible with the
 * SDK's tool() function (which expects AnyZodRawShape, not z.ZodObject).
 *
 * Supports the 5 TypeBox primitives used across GSD's 3 tool schemas:
 *   Type.Object, Type.String, Type.Optional(Type.String)
 *
 * Optionality is determined by the standard JSON Schema `required` array on
 * the parent TObject — keys absent from `required` are optional.
 * This avoids the fragile Symbol.for("TypeBox.Optional") check.
 *
 * @param schema - A TypeBox TObject with string properties
 * @returns A raw Zod shape: Record<string, z.ZodTypeAny>
 */
export function typeboxToZodShape(schema: TObject): Record<string, z.ZodTypeAny> {
  const requiredKeys = new Set<string>(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(schema.properties)) {
    // Extract description — TypeBox propagates it to the property object
    const description = (prop as { description?: string }).description;

    // Build base Zod string with description if present
    const base: z.ZodString = description
      ? z.string().describe(description)
      : z.string();

    // If the key is not in the required array, mark it optional
    shape[key] = requiredKeys.has(key) ? base : base.optional();
  }

  return shape;
}

// ─── Prompt wrapper ────────────────────────────────────────────────────────

/**
 * Wrap a prompt string as an AsyncIterable<SDKUserMessage> for use with
 * the SDK's query() function.
 *
 * The SDK's query() accepts either a string or AsyncIterable<SDKUserMessage>
 * as its prompt. The AsyncIterable form is required when MCP tools are
 * registered (createSdkMcpServer is used), as it enables streaming input.
 *
 * @param prompt - The prompt text to yield
 * @returns An async generator yielding a single SDKUserMessage
 */
export async function* wrapPromptAsAsyncIterable(
  prompt: string,
): AsyncGenerator<{ role: "user"; content: string }> {
  yield { role: "user", content: prompt };
}

// ─── GSD tool TypeBox schema definitions ───────────────────────────────────
// These mirror the exact TypeBox definitions in index.ts lines 256-404.
// TypeBox is the single source of truth — these are exact copies, NOT
// independent definitions. Any change to the schemas in index.ts must
// be reflected here.

const GSD_SAVE_DECISION_SCHEMA = Type.Object({
  scope: Type.String({ description: "Scope of the decision (e.g. 'architecture', 'library', 'observability')" }),
  decision: Type.String({ description: "What is being decided" }),
  choice: Type.String({ description: "The choice made" }),
  rationale: Type.String({ description: "Why this choice was made" }),
  revisable: Type.Optional(Type.String({ description: "Whether this can be revisited (default: 'Yes')" })),
  when_context: Type.Optional(Type.String({ description: "When/context for the decision (e.g. milestone ID)" })),
});

const GSD_UPDATE_REQUIREMENT_SCHEMA = Type.Object({
  id: Type.String({ description: "The requirement ID (e.g. R001, R014)" }),
  status: Type.Optional(Type.String({ description: "New status (e.g. 'active', 'validated', 'deferred')" })),
  validation: Type.Optional(Type.String({ description: "Validation criteria or proof" })),
  notes: Type.Optional(Type.String({ description: "Additional notes" })),
  description: Type.Optional(Type.String({ description: "Updated description" })),
  primary_owner: Type.Optional(Type.String({ description: "Primary owning slice" })),
  supporting_slices: Type.Optional(Type.String({ description: "Supporting slices" })),
});

const GSD_SAVE_SUMMARY_SCHEMA = Type.Object({
  milestone_id: Type.String({ description: "Milestone ID (e.g. M001)" }),
  slice_id: Type.Optional(Type.String({ description: "Slice ID (e.g. S01)" })),
  task_id: Type.Optional(Type.String({ description: "Task ID (e.g. T01)" })),
  artifact_type: Type.String({ description: "One of: SUMMARY, RESEARCH, CONTEXT, ASSESSMENT" }),
  content: Type.String({ description: "The full markdown content of the artifact" }),
});

// ─── MCP server creation ───────────────────────────────────────────────────

/**
 * Create the GSD in-process MCP server with 3 registered tools.
 *
 * Dynamically imports the Claude Agent SDK — this is an optional dependency
 * that must be installed separately when using the claude-code provider.
 * Fails with a clear install-instructions error if the SDK is absent.
 *
 * The returned server config object is passed to query() via:
 *   options.mcpServers: { "gsd-tools": server }
 *
 * @returns The MCP server config object from createSdkMcpServer()
 */
export async function createGsdMcpServer() {
  let sdk: typeof import("@anthropic-ai/claude-agent-sdk");
  try {
    sdk = await import("@anthropic-ai/claude-agent-sdk");
  } catch {
    throw new Error(
      "Claude Code provider requires @anthropic-ai/claude-agent-sdk.\n" +
      "Run: npm install @anthropic-ai/claude-agent-sdk",
    );
  }

  const { createSdkMcpServer, tool } = sdk;

  // Convert the TypeBox schemas to Zod shapes once at registration time
  const saveDecisionShape = typeboxToZodShape(GSD_SAVE_DECISION_SCHEMA);
  const updateRequirementShape = typeboxToZodShape(GSD_UPDATE_REQUIREMENT_SCHEMA);
  const saveSummaryShape = typeboxToZodShape(GSD_SAVE_SUMMARY_SCHEMA);

  return createSdkMcpServer({
    name: "gsd-tools",
    version: "1.0.0",
    tools: [
      tool(
        "gsd_save_decision",
        "Record a project decision to the GSD database and regenerate DECISIONS.md. " +
        "Decision IDs are auto-assigned — never provide an ID manually.",
        saveDecisionShape,
        async (args: Record<string, string | undefined>) => {
          // Guard: check DB availability before attempting write
          let dbAvailable = false;
          try {
            const db = await import("../gsd-db.js");
            dbAvailable = db.isDbAvailable();
          } catch { /* dynamic import failed */ }

          if (!dbAvailable) {
            return {
              content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot save decision." }],
            };
          }

          try {
            const { saveDecisionToDb } = await import("../db-writer.js");
            const { id } = await saveDecisionToDb(
              {
                scope: args["scope"] as string,
                decision: args["decision"] as string,
                choice: args["choice"] as string,
                rationale: args["rationale"] as string,
                revisable: args["revisable"],
                when_context: args["when_context"],
              },
              process.cwd(),
            );
            return { content: [{ type: "text" as const, text: `Saved decision ${id}` }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`gsd-db: gsd_save_decision (sdk) failed: ${msg}\n`);
            return { content: [{ type: "text" as const, text: `Error saving decision: ${msg}` }] };
          }
        },
      ),

      tool(
        "gsd_update_requirement",
        "Update an existing requirement in the GSD database and regenerate REQUIREMENTS.md. " +
        "Provide the requirement ID (e.g. R001) and any fields to update.",
        updateRequirementShape,
        async (args: Record<string, string | undefined>) => {
          let dbAvailable = false;
          try {
            const db = await import("../gsd-db.js");
            dbAvailable = db.isDbAvailable();
          } catch { /* dynamic import failed */ }

          if (!dbAvailable) {
            return {
              content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot update requirement." }],
            };
          }

          try {
            const db = await import("../gsd-db.js");
            const id = args["id"] as string;
            const existing = db.getRequirementById(id);
            if (!existing) {
              return {
                content: [{ type: "text" as const, text: `Error: Requirement ${id} not found.` }],
              };
            }

            const { updateRequirementInDb } = await import("../db-writer.js");
            const updates: Record<string, string | undefined> = {};
            if (args["status"] !== undefined) updates["status"] = args["status"];
            if (args["validation"] !== undefined) updates["validation"] = args["validation"];
            if (args["notes"] !== undefined) updates["notes"] = args["notes"];
            if (args["description"] !== undefined) updates["description"] = args["description"];
            if (args["primary_owner"] !== undefined) updates["primary_owner"] = args["primary_owner"];
            if (args["supporting_slices"] !== undefined) updates["supporting_slices"] = args["supporting_slices"];

            await updateRequirementInDb(id, updates, process.cwd());

            return { content: [{ type: "text" as const, text: `Updated requirement ${id}` }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`gsd-db: gsd_update_requirement (sdk) failed: ${msg}\n`);
            return { content: [{ type: "text" as const, text: `Error updating requirement: ${msg}` }] };
          }
        },
      ),

      tool(
        "gsd_save_summary",
        "Save a summary, research, context, or assessment artifact to the GSD database and write it to disk. " +
        "Computes the file path from milestone/slice/task IDs automatically.",
        saveSummaryShape,
        async (args: Record<string, string | undefined>) => {
          let dbAvailable = false;
          try {
            const db = await import("../gsd-db.js");
            dbAvailable = db.isDbAvailable();
          } catch { /* dynamic import failed */ }

          if (!dbAvailable) {
            return {
              content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot save artifact." }],
            };
          }

          const validTypes = ["SUMMARY", "RESEARCH", "CONTEXT", "ASSESSMENT"];
          const artifactType = args["artifact_type"] as string;
          if (!validTypes.includes(artifactType)) {
            return {
              content: [{ type: "text" as const, text: `Error: Invalid artifact_type "${artifactType}". Must be one of: ${validTypes.join(", ")}` }],
            };
          }

          try {
            const milestoneId = args["milestone_id"] as string;
            const sliceId = args["slice_id"];
            const taskId = args["task_id"];

            // Compute relative path from IDs — same logic as index.ts
            let relativePath: string;
            if (taskId && sliceId) {
              relativePath = `milestones/${milestoneId}/slices/${sliceId}/tasks/${taskId}-${artifactType}.md`;
            } else if (sliceId) {
              relativePath = `milestones/${milestoneId}/slices/${sliceId}/${sliceId}-${artifactType}.md`;
            } else {
              relativePath = `milestones/${milestoneId}/${milestoneId}-${artifactType}.md`;
            }

            const { saveArtifactToDb } = await import("../db-writer.js");
            await saveArtifactToDb(
              {
                path: relativePath,
                artifact_type: artifactType,
                content: args["content"] as string,
                milestone_id: milestoneId,
                slice_id: sliceId,
                task_id: taskId,
              },
              process.cwd(),
            );

            return { content: [{ type: "text" as const, text: `Saved ${artifactType} artifact to ${relativePath}` }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`gsd-db: gsd_save_summary (sdk) failed: ${msg}\n`);
            return { content: [{ type: "text" as const, text: `Error saving artifact: ${msg}` }] };
          }
        },
      ),
    ],
  });
}
