/**
 * GSD tool definitions for SDK-based providers.
 *
 * Defines the 3 GSD custom tools (save_decision, update_requirement,
 * save_summary) with full type safety via defineGsdTool<T>(). These are
 * registered in the shared tool registry during extension init, and any
 * provider (claude-code, codex, gemini) can consume them.
 *
 * All GSD database knowledge lives HERE — provider directories never
 * import GSD core modules.
 */

import { z } from "zod";
import { defineGsdTool } from "./provider-api/define-tool.js";
import { registerGsdTool } from "./provider-api/tool-registry.js";

// ─── gsd_save_decision ────────────────────────────────────────────────────

const saveDecisionTool = defineGsdTool(
  "gsd_save_decision",
  "Record a project decision to the GSD database and regenerate DECISIONS.md. " +
  "Decision IDs are auto-assigned — never provide an ID manually.",
  {
    scope: z.string().describe("Scope of the decision (e.g. 'architecture', 'library', 'observability')"),
    decision: z.string().describe("What is being decided"),
    choice: z.string().describe("The choice made"),
    rationale: z.string().describe("Why this choice was made"),
    revisable: z.string().optional().describe("Whether this can be revisited (default: 'Yes')"),
    when_context: z.string().optional().describe("When/context for the decision (e.g. milestone ID)"),
  },
  async (args) => {
    let dbAvailable = false;
    try {
      const db = await import("./gsd-db.js");
      dbAvailable = db.isDbAvailable();
    } catch { /* dynamic import failed */ }

    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot save decision." }],
      };
    }

    try {
      const { saveDecisionToDb } = await import("./db-writer.js");
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
      process.stderr.write(`gsd-db: gsd_save_decision failed: ${msg}\n`);
      return { content: [{ type: "text" as const, text: `Error saving decision: ${msg}` }] };
    }
  },
);

// ─── gsd_update_requirement ───────────────────────────────────────────────

const updateRequirementTool = defineGsdTool(
  "gsd_update_requirement",
  "Update an existing requirement in the GSD database and regenerate REQUIREMENTS.md. " +
  "Provide the requirement ID (e.g. R001) and any fields to update.",
  {
    id: z.string().describe("The requirement ID (e.g. R001, R014)"),
    status: z.string().optional().describe("New status (e.g. 'active', 'validated', 'deferred')"),
    validation: z.string().optional().describe("Validation criteria or proof"),
    notes: z.string().optional().describe("Additional notes"),
    description: z.string().optional().describe("Updated description"),
    primary_owner: z.string().optional().describe("Primary owning slice"),
    supporting_slices: z.string().optional().describe("Supporting slices"),
  },
  async (args) => {
    let dbAvailable = false;
    try {
      const db = await import("./gsd-db.js");
      dbAvailable = db.isDbAvailable();
    } catch { /* dynamic import failed */ }

    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot update requirement." }],
      };
    }

    try {
      const db = await import("./gsd-db.js");
      const existing = db.getRequirementById(args.id);
      if (!existing) {
        return {
          content: [{ type: "text" as const, text: `Error: Requirement ${args.id} not found.` }],
        };
      }

      const { updateRequirementInDb } = await import("./db-writer.js");
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
      process.stderr.write(`gsd-db: gsd_update_requirement failed: ${msg}\n`);
      return { content: [{ type: "text" as const, text: `Error updating requirement: ${msg}` }] };
    }
  },
);

// ─── gsd_save_summary ─────────────────────────────────────────────────────

const saveSummaryTool = defineGsdTool(
  "gsd_save_summary",
  "Save a summary, research, context, or assessment artifact to the GSD database and write it to disk. " +
  "Computes the file path from milestone/slice/task IDs automatically.",
  {
    milestone_id: z.string().describe("Milestone ID (e.g. M001)"),
    slice_id: z.string().optional().describe("Slice ID (e.g. S01)"),
    task_id: z.string().optional().describe("Task ID (e.g. T01)"),
    artifact_type: z.string().describe("One of: SUMMARY, RESEARCH, CONTEXT, ASSESSMENT"),
    content: z.string().describe("The full markdown content of the artifact"),
  },
  async (args) => {
    let dbAvailable = false;
    try {
      const db = await import("./gsd-db.js");
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

      const { saveArtifactToDb } = await import("./db-writer.js");
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
      process.stderr.write(`gsd-db: gsd_save_summary failed: ${msg}\n`);
      return { content: [{ type: "text" as const, text: `Error saving artifact: ${msg}` }] };
    }
  },
);

// ─── Registration ─────────────────────────────────────────────────────────

export function registerAllGsdTools(): void {
  registerGsdTool(saveDecisionTool);
  registerGsdTool(updateRequirementTool);
  registerGsdTool(saveSummaryTool);
}
