import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { handleAutoCommand } from "./handlers/auto.js";
import { handleCoreCommand } from "./handlers/core.js";
import { handleOpsCommand } from "./handlers/ops.js";
import { handleParallelCommand } from "./handlers/parallel.js";
import { handleWorkflowCommand } from "./handlers/workflow.js";

export async function handleGSDCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const trimmed = (typeof args === "string" ? args : "").trim();

  const handlers = [
    () => handleCoreCommand(trimmed, ctx),
    () => handleAutoCommand(trimmed, ctx, pi),
    () => handleParallelCommand(trimmed, ctx, pi),
    () => handleWorkflowCommand(trimmed, ctx, pi),
    () => handleOpsCommand(trimmed, ctx, pi),
    () => handlePluginCommand(trimmed, ctx, pi),
  ];

  for (const handler of handlers) {
    if (await handler()) {
      return;
    }
  }

  ctx.ui.notify(`Unknown: /gsd ${trimmed}. Run /gsd help for available commands.`, "warning");
}

async function handlePluginCommand(trimmed: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<boolean> {
  if (!trimmed.startsWith("plugin")) return false;
  const binPath = process.env.GSD_BIN_PATH;
  if (!binPath) return false;
  try {
    const { dirname, join } = require("node:path");
    const cliPath = join(dirname(binPath), "plugin-system", "plugin-cli.js");
    const { handlePlugin } = await import(cliPath);
    await handlePlugin(trimmed.replace(/^plugin\s*/, "").trim(), ctx, pi);
    return true;
  } catch {
    return false;
  }
}

