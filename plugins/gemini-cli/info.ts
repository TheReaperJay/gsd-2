/**
 * Gemini CLI provider — static metadata and info registration.
 *
 * Uses the gemini CLI binary for auth checking and the --output-format
 * stream-json flag for streaming responses. No SDK dependency — the
 * streaming is parsed from newline-delimited JSON output.
 *
 * Self-registers via registerProviderInfo() as a side effect of import.
 */

import { registerProviderInfo } from "@gsd/provider-api";
import type { GsdProviderInfo, GsdModel, GsdStreamContext, GsdProviderDeps, GsdEvent } from "@gsd/provider-api";
import { spawnSync, spawn } from "node:child_process";

// ─── Auth check ───────────────────────────────────────────────────────────────

function checkGeminiCli(
  spawnFn: typeof spawnSync = spawnSync,
): { ok: true; email?: string } | { ok: false; reason: string; instruction: string } {
  const versionResult = spawnFn("gemini", ["--version"], { encoding: "utf-8" });
  if (versionResult.error || versionResult.status !== 0) {
    return {
      ok: false,
      reason: "not-found",
      instruction: "Install Gemini CLI: npm install -g @google/gemini-cli",
    };
  }

  const authResult = spawnFn("gemini", ["auth", "status"], { encoding: "utf-8" });
  if (authResult.error || authResult.status !== 0) {
    return {
      ok: false,
      reason: "not-authenticated",
      instruction: "Run 'gemini auth login' in your terminal",
    };
  }

  // Parse output for auth state
  const output = (authResult.stdout || "").toLowerCase();
  if (output.includes("not authenticated") || output.includes("no authentication")) {
    return {
      ok: false,
      reason: "not-authenticated",
      instruction: "Run 'gemini auth login' in your terminal",
    };
  }

  return { ok: true };
}

// ─── Event queue ──────────────────────────────────────────────────────────────

type EventQueueResolver = (value: IteratorResult<GsdEvent>) => void;

interface EventQueue {
  events: GsdEvent[];
  resolver: EventQueueResolver | null;
  done: boolean;
  push(event: GsdEvent): void;
  finish(): void;
  next(): Promise<IteratorResult<GsdEvent>>;
}

function createEventQueue(): EventQueue {
  const q: EventQueue = {
    events: [],
    resolver: null,
    done: false,
    push(event: GsdEvent) {
      if (q.resolver) {
        const resolve = q.resolver;
        q.resolver = null;
        resolve({ value: event, done: false });
      } else {
        q.events.push(event);
      }
    },
    finish() {
      q.done = true;
      if (q.resolver) {
        const resolve = q.resolver;
        q.resolver = null;
        resolve({ value: undefined as unknown as GsdEvent, done: true });
      }
    },
    next(): Promise<IteratorResult<GsdEvent>> {
      if (q.events.length > 0) {
        return Promise.resolve({ value: q.events.shift()!, done: false });
      }
      if (q.done) {
        return Promise.resolve({ value: undefined as unknown as GsdEvent, done: true });
      }
      return new Promise<IteratorResult<GsdEvent>>(resolve => {
        q.resolver = resolve;
      });
    },
  };
  return q;
}

// ─── Model aliases ────────────────────────────────────────────────────────────

const MODEL_ALIASES: Record<string, string> = {
  "gemini-cli:gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-cli:gemini-2.5-flash": "gemini-2.5-flash",
  "gemini-cli:gemini-2.0-flash": "gemini-2.0-flash",
};

// ─── createStream implementation ──────────────────────────────────────────────

/**
 * Spawns the gemini CLI with --output-format stream-json and parses the
 * newline-delimited JSON events into GsdEvents.
 */
function geminiCreateStream(
  context: GsdStreamContext,
  deps: GsdProviderDeps,
): AsyncIterable<GsdEvent> {
  const queue = createEventQueue();

  (async () => {
    const modelName = MODEL_ALIASES[context.modelId] ?? "gemini-2.5-pro";
    const basePath = deps.getBasePath();

    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const proc = spawn("gemini", [
        "--output-format", "stream-json",
        "-m", modelName,
        "--prompt", context.userPrompt,
      ], {
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let buffer = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            const type = event.type as string;

            if (type === "text" || type === "text_delta") {
              const text = String(event.text ?? event.content ?? "");
              if (text) queue.push({ type: "text_delta", text });
            } else if (type === "thinking" || type === "thinking_delta") {
              const thinking = String(event.thinking ?? event.content ?? "");
              if (thinking) queue.push({ type: "thinking_delta", thinking });
            } else if (type === "tool_use" || type === "tool_start") {
              queue.push({
                type: "tool_start",
                toolCallId: String(event.id ?? event.tool_use_id ?? ""),
                toolName: String(event.name ?? event.tool_name ?? ""),
              });
              deps.onToolStart(String(event.id ?? event.tool_use_id ?? ""));
            } else if (type === "tool_result" || type === "tool_end") {
              const toolId = String(event.id ?? event.tool_use_id ?? "");
              queue.push({ type: "tool_end", toolCallId: toolId });
              deps.onToolEnd(toolId);
            } else if (type === "usage") {
              inputTokens += typeof event.input_tokens === "number" ? event.input_tokens : 0;
              outputTokens += typeof event.output_tokens === "number" ? event.output_tokens : 0;
            } else if (type === "error") {
              queue.push({
                type: "error",
                message: String(event.message ?? event.error ?? "Gemini CLI error"),
                category: "unknown",
              });
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          process.stderr.write(`[gemini-cli] ${text}\n`);
        }
      });

      await new Promise<void>((resolve, reject) => {
        proc.on("close", (code) => {
          // Process any remaining buffer
          if (buffer.trim()) {
            try {
              const event = JSON.parse(buffer) as Record<string, unknown>;
              if (event.type === "text" || event.type === "text_delta") {
                queue.push({ type: "text_delta", text: String(event.text ?? event.content ?? "") });
              }
            } catch { /* ignore */ }
          }

          if (code !== 0 && code !== null) {
            reject(new Error(`gemini process exited with code ${code}`));
          } else {
            resolve();
          }
        });
        proc.on("error", reject);
      });

      queue.push({
        type: "completion",
        usage: { inputTokens, outputTokens },
        stopReason: "stop",
      });
    } catch (err) {
      queue.push({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        category: "unknown",
      });
    } finally {
      queue.finish();
    }
  })();

  return {
    [Symbol.asyncIterator]() {
      return { next: () => queue.next() };
    },
  };
}

// ─── Models ───────────────────────────────────────────────────────────────────

const geminiModels: GsdModel[] = [
  { id: "gemini-cli:gemini-2.5-pro", displayName: "Gemini 2.5 Pro (via Gemini CLI)", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gemini-cli:gemini-2.5-flash", displayName: "Gemini 2.5 Flash (via Gemini CLI)", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gemini-cli:gemini-2.0-flash", displayName: "Gemini 2.0 Flash (via Gemini CLI)", reasoning: false, contextWindow: 1000000, maxTokens: 8192 },
];

// ─── Provider info ────────────────────────────────────────────────────────────

export const geminiCliProviderInfo: GsdProviderInfo = {
  id: "gemini-cli",
  displayName: "Gemini CLI (Google)",
  auth: {
    type: "cli",
    hint: "requires gemini CLI installed and authenticated",
    check: checkGeminiCli,
    credential: { type: "api_key", key: "cli-managed" },
  },
  defaultModel: "gemini-cli:gemini-2.5-pro",
  models: geminiModels,
  createStream: geminiCreateStream,
};

registerProviderInfo(geminiCliProviderInfo);
