/**
 * GSD MCP Tools — SDK tool registration via createSdkMcpServer
 *
 * Registers GSD's 3 custom tools (gsd_save_decision, gsd_update_requirement,
 * gsd_save_summary) with the Claude Agent SDK's in-process MCP server.
 *
 * Zod shapes are defined directly as typed consts so the SDK's InferShape<T>
 * generic provides fully typed callback args with zero casts.
 *
 * Exports:
 * - wrapPromptAsAsyncIterable() — wraps a prompt string as AsyncIterable<SDKUserMessage>
 * - createGsdMcpServer() — creates and returns the in-process MCP server config
 */

import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

// ─── Zod shapes (typed consts for SDK InferShape inference) ─────────────────

const saveDecisionShape = {
  scope: z.string().describe("Scope of the decision (e.g. 'architecture', 'library', 'observability')"),
  decision: z.string().describe("What is being decided"),
  choice: z.string().describe("The choice made"),
  rationale: z.string().describe("Why this choice was made"),
  revisable: z.string().optional().describe("Whether this can be revisited (default: 'Yes')"),
  when_context: z.string().optional().describe("When/context for the decision (e.g. milestone ID)"),
} as const;

const updateRequirementShape = {
  id: z.string().describe("The requirement ID (e.g. R001, R014)"),
  status: z.string().optional().describe("New status (e.g. 'active', 'validated', 'deferred')"),
  validation: z.string().optional().describe("Validation criteria or proof"),
  notes: z.string().optional().describe("Additional notes"),
  description: z.string().optional().describe("Updated description"),
  primary_owner: z.string().optional().describe("Primary owning slice"),
  supporting_slices: z.string().optional().describe("Supporting slices"),
} as const;

const saveSummaryShape = {
  milestone_id: z.string().describe("Milestone ID (e.g. M001)"),
  slice_id: z.string().optional().describe("Slice ID (e.g. S01)"),
  task_id: z.string().optional().describe("Task ID (e.g. T01)"),
  artifact_type: z.string().describe("One of: SUMMARY, RESEARCH, CONTEXT, ASSESSMENT"),
  content: z.string().describe("The full markdown content of the artifact"),
} as const;

// ─── Prompt wrapper ────────────────────────────────────────────────────────

/**
 * Wrap a prompt string as an AsyncIterable<SDKUserMessage> for use with
 * the SDK's query() function.
 *
 * The SDK's query() accepts either a string or AsyncIterable<SDKUserMessage>
 * as its prompt. The AsyncIterable form is required when MCP tools are
 * registered (createSdkMcpServer is used), as it enables streaming input.
 *
 * Yields a single SDKUserMessage with the prompt text, then returns.
 */
export async function* wrapPromptAsAsyncIterable(prompt: string) {
  yield {
    role: "user" as const,
    content: [{ type: "text" as const, text: prompt }],
  };
}

// ─── MCP server creation ───────────────────────────────────────────────────

/**
 * Create the GSD in-process MCP server with 3 registered tools.
 *
 * The returned server config object is passed to query() via:
 *   options.mcpServers: { "gsd-tools": server }
 *
 * @returns The MCP server config object from createSdkMcpServer()
 */
export async function createGsdMcpServer() {
  return createSdkMcpServer({
    name: "gsd-tools",
    version: "1.0.0",
    tools: [
      tool(
        "gsd_save_decision",
        "Record a project decision to the GSD database and regenerate DECISIONS.md. " +
        "Decision IDs are auto-assigned — never provide an ID manually.",
        saveDecisionShape,
        async (args) => {
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
                scope: args.scope,
                decision: args.decision,
                choice: args.choice,
                rationale: args.rationale,
                revisable: args.revisable,
                when_context: args.when_context,
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
        async (args) => {
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
            const existing = db.getRequirementById(args.id);
            if (!existing) {
              return {
                content: [{ type: "text" as const, text: `Error: Requirement ${args.id} not found.` }],
              };
            }

            const { updateRequirementInDb } = await import("../db-writer.js");
            const updates: Record<string, string> = {};
            if (args.status !== undefined) updates["status"] = args.status;
            if (args.validation !== undefined) updates["validation"] = args.validation;
            if (args.notes !== undefined) updates["notes"] = args.notes;
            if (args.description !== undefined) updates["description"] = args.description;
            if (args.primary_owner !== undefined) updates["primary_owner"] = args.primary_owner;
            if (args.supporting_slices !== undefined) updates["supporting_slices"] = args.supporting_slices;

            await updateRequirementInDb(args.id, updates, process.cwd());

            return { content: [{ type: "text" as const, text: `Updated requirement ${args.id}` }] };
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
        async (args) => {
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
          if (!validTypes.includes(args.artifact_type)) {
            return {
              content: [{ type: "text" as const, text: `Error: Invalid artifact_type "${args.artifact_type}". Must be one of: ${validTypes.join(", ")}` }],
            };
          }

          try {
            let relativePath: string;
            if (args.task_id && args.slice_id) {
              relativePath = `milestones/${args.milestone_id}/slices/${args.slice_id}/tasks/${args.task_id}-${args.artifact_type}.md`;
            } else if (args.slice_id) {
              relativePath = `milestones/${args.milestone_id}/slices/${args.slice_id}/${args.slice_id}-${args.artifact_type}.md`;
            } else {
              relativePath = `milestones/${args.milestone_id}/${args.milestone_id}-${args.artifact_type}.md`;
            }

            const { saveArtifactToDb } = await import("../db-writer.js");
            await saveArtifactToDb(
              {
                path: relativePath,
                artifact_type: args.artifact_type,
                content: args.content,
                milestone_id: args.milestone_id,
                slice_id: args.slice_id,
                task_id: args.task_id,
              },
              process.cwd(),
            );

            return { content: [{ type: "text" as const, text: `Saved ${args.artifact_type} artifact to ${relativePath}` }] };
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
