/**
 * Type-safe helper for defining GSD tools.
 *
 * Preserves compile-time arg typing at the definition site via generic
 * inference from the Zod schema, then erases the generic for the
 * GsdToolDef interface so the registry can store heterogeneous tools.
 *
 * Usage:
 *   const myTool = defineGsdTool(
 *     "tool_name",
 *     "description",
 *     { field: z.string() },
 *     async (args) => {
 *       // args.field is typed as string
 *       return { content: [{ type: "text", text: "result" }] };
 *     },
 *   );
 */

import type { z } from "zod";
import type { GsdToolDef } from "./types.js";

export function defineGsdTool<T extends Record<string, z.ZodTypeAny>>(
  name: string,
  description: string,
  schema: T,
  execute: (args: { [K in keyof T]: z.infer<T[K]> }) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
): GsdToolDef {
  return { name, description, schema, execute: execute as GsdToolDef["execute"] };
}
