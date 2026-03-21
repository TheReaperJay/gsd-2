/**
 * Generic adapter that bridges GSD provider declarations to Pi.
 *
 * wireProvidersToPI reads getRegisteredProviderInfos() after discovery and
 * calls pi.registerProvider() for each provider — no per-provider Pi wiring
 * code required.
 *
 * GsdEventStream (async iterable of GsdEvent) is translated to Pi's
 * AssistantMessageEventStream, building the AssistantMessage accumulator Pi
 * expects on every event push. Tool events drive TUI status display via
 * ctx.ui.setStatus() and are NOT forwarded to the Pi stream.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import type { Api, Model, Context, SimpleStreamOptions, AssistantMessage, AssistantMessageEventStream, TextContent, Message, StopReason } from "@gsd/pi-ai";
import type { GsdProviderInfo, GsdProviderDeps } from "./types.js";
import { getRegisteredProviderInfos, getProviderDeps } from "./provider-registry.js";

// ─── User prompt extraction ───────────────────────────────────────────────────

/**
 * Extract the text content of the last user message from a Pi message array.
 * The system prompt is sent separately via context.systemPrompt; this extracts
 * the user task text that the provider stream should process.
 */
function extractUserPrompt(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((c): c is TextContent => c.type === "text")
          .map(c => c.text)
          .join("\n");
      }
    }
  }
  return "";
}

// ─── createStreamSimple ───────────────────────────────────────────────────────

/**
 * Factory that creates a streamSimple function for a single GSD provider.
 *
 * Captures info and a getCtx accessor at factory creation time. Per-invocation
 * state (deps, model, context) is resolved at call time so stale snapshots are
 * never captured at registration time.
 *
 * @param info - Static provider metadata (id, models, createStream)
 * @param getCtx - Returns the active ExtensionContext, or null between sessions
 * @returns A streamSimple function compatible with Pi's ProviderConfig.streamSimple
 */
function createStreamSimple(
  info: GsdProviderInfo,
  getCtx: () => ExtensionContext | null,
  StreamClass: new () => AssistantMessageEventStream,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  return function streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = new StreamClass();

    // Build the AssistantMessage accumulator — must be on partial: output on every event push.
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api as Api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    (async () => {
      // Read deps at call time — not captured at registration time.
      // getProviderDeps() returns null if setProviderDeps hasn't been called yet.
      const deps: GsdProviderDeps | null = getProviderDeps();

      if (deps === null) {
        output.stopReason = "error";
        output.errorMessage = "GSD provider deps not initialized — provider invoked before discovery completed";
        stream.push({ type: "error", reason: "error", error: output });
        stream.end();
        return;
      }

      const userPrompt = extractUserPrompt(context.messages);

      // Build GsdStreamContext from Pi parameters.
      // supervisorConfig is read from deps at call time — reflects current settings.
      const gsdContext = {
        modelId: model.id,
        systemPrompt: context.systemPrompt ?? "",
        userPrompt,
        supervisorConfig: deps.getSupervisorConfig(),
      };

      stream.push({ type: "start", partial: output });

      let activeContentIndex = -1;
      let activeThinkingIndex = -1;
      let ended = false;

      try {
        const gsdStream = info.createStream(gsdContext, deps);

        for await (const event of gsdStream) {
          switch (event.type) {
            case "text_delta": {
              if (activeContentIndex === -1) {
                // GsdEvent has no text_start — synthesize it before the first delta.
                const textBlock: TextContent = { type: "text", text: "" };
                output.content.push(textBlock);
                activeContentIndex = output.content.length - 1;
                stream.push({ type: "text_start", contentIndex: activeContentIndex, partial: output });
              }
              const block = output.content[activeContentIndex];
              if (block && block.type === "text") block.text += event.text;
              stream.push({ type: "text_delta", contentIndex: activeContentIndex, delta: event.text, partial: output });
              break;
            }

            case "thinking_delta": {
              if (activeThinkingIndex === -1) {
                // GsdEvent has no thinking_start — synthesize it before the first delta.
                output.content.push({ type: "thinking", thinking: "" });
                activeThinkingIndex = output.content.length - 1;
                stream.push({ type: "thinking_start", contentIndex: activeThinkingIndex, partial: output });
              }
              const thinkBlock = output.content[activeThinkingIndex];
              if (thinkBlock && thinkBlock.type === "thinking") thinkBlock.thinking += event.thinking;
              stream.push({ type: "thinking_delta", contentIndex: activeThinkingIndex, delta: event.thinking, partial: output });
              break;
            }

            case "tool_start": {
              // Drive TUI status — NOT forwarded to Pi stream (avoids Pitfall 3 in reverse).
              const ctx = getCtx();
              if (ctx) {
                const statusText = event.detail
                  ? `${event.toolName.toLowerCase()}: ${event.detail}`
                  : event.toolName.toLowerCase();
                ctx.ui.setStatus(`${info.id}-tool`, statusText);
              }
              break;
            }

            case "tool_end": {
              // Clear TUI status — NOT forwarded to Pi stream.
              const ctx = getCtx();
              if (ctx) ctx.ui.setStatus(`${info.id}-tool`, undefined);
              break;
            }

            case "completion": {
              // Close any open text block.
              if (activeContentIndex >= 0) {
                const block = output.content[activeContentIndex];
                const text = block && block.type === "text" ? block.text : "";
                stream.push({ type: "text_end", contentIndex: activeContentIndex, content: text, partial: output });
                activeContentIndex = -1;
              }
              // Close any open thinking block — content is the accumulated thinking text.
              if (activeThinkingIndex >= 0) {
                const thinkBlock = output.content[activeThinkingIndex];
                const thinkText = thinkBlock && thinkBlock.type === "thinking" ? thinkBlock.thinking : "";
                stream.push({ type: "thinking_end", contentIndex: activeThinkingIndex, content: thinkText, partial: output });
                activeThinkingIndex = -1;
              }
              // Update usage from provider report.
              output.usage.input = event.usage.inputTokens;
              output.usage.output = event.usage.outputTokens;
              if (event.usage.cacheReadTokens !== undefined) output.usage.cacheRead = event.usage.cacheReadTokens;
              if (event.usage.cacheWriteTokens !== undefined) output.usage.cacheWrite = event.usage.cacheWriteTokens;
              output.usage.totalTokens = event.usage.inputTokens + event.usage.outputTokens;
              // Map provider stopReason to Pi's StopReason union.
              output.stopReason = (event.stopReason === "stop" || event.stopReason === "length" || event.stopReason === "toolUse")
                ? event.stopReason as StopReason
                : "stop";
              stream.push({ type: "done", reason: output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse">, message: output });
              stream.end();
              ended = true;
              break;
            }

            case "error": {
              // Close any open blocks before emitting error.
              if (activeContentIndex >= 0) {
                const block = output.content[activeContentIndex];
                const text = block && block.type === "text" ? block.text : "";
                stream.push({ type: "text_end", contentIndex: activeContentIndex, content: text, partial: output });
                activeContentIndex = -1;
              }
              if (activeThinkingIndex >= 0) {
                const thinkBlock = output.content[activeThinkingIndex];
                const thinkText = thinkBlock && thinkBlock.type === "thinking" ? thinkBlock.thinking : "";
                stream.push({ type: "thinking_end", contentIndex: activeThinkingIndex, content: thinkText, partial: output });
                activeThinkingIndex = -1;
              }
              output.stopReason = "error";
              output.errorMessage = event.message;
              stream.push({ type: "error", reason: "error", error: output });
              stream.end();
              ended = true;
              break;
            }
          }
        }

        // If stream ended without a completion/error event (empty stream or provider crash).
        if (!ended) {
          if (activeContentIndex >= 0) {
            const block = output.content[activeContentIndex];
            const text = block && block.type === "text" ? block.text : "";
            stream.push({ type: "text_end", contentIndex: activeContentIndex, content: text, partial: output });
          }
          if (activeThinkingIndex >= 0) {
            const thinkBlock = output.content[activeThinkingIndex];
            const thinkText = thinkBlock && thinkBlock.type === "thinking" ? thinkBlock.thinking : "";
            stream.push({ type: "thinking_end", contentIndex: activeThinkingIndex, content: thinkText, partial: output });
          }
          stream.push({ type: "done", reason: "stop", message: output });
          stream.end();
        }
      } catch (err) {
        // Catch errors from createStream or the for-await loop.
        // If the AbortSignal was aborted, classify as "aborted"; otherwise "error".
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
        stream.end();
      }
    })();

    return stream;
  };
}

// ─── wireProvidersToPI ────────────────────────────────────────────────────────

/**
 * Wire all registered GSD providers to Pi generically.
 *
 * Called once in the extension factory after discoverLocalProviders() completes
 * and setProviderDeps() has run. Reads getRegisteredProviderInfos() to iterate
 * every registered provider and calls pi.registerProvider() for each — no
 * per-provider Pi wiring code needed.
 *
 * @param pi - Pi's ExtensionAPI — registerProvider, on("agent_start"), on("agent_end")
 */
export async function wireProvidersToPI(pi: ExtensionAPI): Promise<void> {
  // Dynamic import to get AssistantMessageEventStream as a value.
  // @gsd/pi-ai's types.ts has `export type { AssistantMessageEventStream }`
  // which prevents static value imports. Property access on the dynamic
  // import result resolves to the actual class constructor.
  const piAi = await import("@gsd/pi-ai");

  // Capture ExtensionContext for TUI status updates — shared across all providers.
  // The context is set at agent_start and cleared at agent_end, so tool status
  // updates reach the correct session's TUI footer.
  let currentCtx: ExtensionContext | null = null;
  pi.on("agent_start", async (_event, ctx) => { currentCtx = ctx; });
  pi.on("agent_end", async () => { currentCtx = null; });

  for (const info of getRegisteredProviderInfos()) {
    pi.registerProvider(info.id, {
      api: info.id,
      baseUrl: `${info.id}:`,
      apiKey: info.id,
      streamSimple: createStreamSimple(info, () => currentCtx, piAi.AssistantMessageEventStream),
      models: info.models.map(m => ({
        id: m.id,
        name: m.displayName,
        api: info.id,
        reasoning: m.reasoning,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    });
  }
}
