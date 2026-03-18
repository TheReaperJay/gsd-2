/**
 * write-gate.ts — CONTEXT.md write-gate (D031 guard chain).
 *
 * Pure function extracted from index.ts so that both index.ts and auto.ts
 * can import it without creating a circular dependency.
 */

const MILESTONE_CONTEXT_RE = /M\d+(?:-[a-z0-9]{6})?-CONTEXT\.md$/;

/**
 * Determines whether a Write tool call should be blocked.
 *
 * Blocks writes to the milestone CONTEXT.md during the discussion phase when
 * depth verification has not yet been completed. Returns { block: true } with
 * an actionable reason in that case; otherwise returns { block: false }.
 *
 * @param toolName      - Lowercased tool name (e.g. "write", "edit")
 * @param inputPath     - Absolute or relative path the Write tool targets
 * @param milestoneId   - Current milestone ID, or null outside discussion phase
 * @param depthVerified - Whether the user has completed depth verification
 */
export function shouldBlockContextWrite(
  toolName: string,
  inputPath: string,
  milestoneId: string | null,
  depthVerified: boolean,
): { block: boolean; reason?: string } {
  if (toolName !== "write") return { block: false };
  if (!milestoneId) return { block: false };
  if (!MILESTONE_CONTEXT_RE.test(inputPath)) return { block: false };
  if (depthVerified) return { block: false };
  return {
    block: true,
    reason: `Blocked: Cannot write to milestone CONTEXT.md during discussion phase without depth verification. Call ask_user_questions with question id "depth_verification" first to confirm discussion depth before writing context.`,
  };
}
