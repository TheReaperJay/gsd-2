/**
 * steering-queue.ts — SteeringQueue and SdkUserMessage for SDK prompt channel
 *
 * Purpose: Extracted from sdk-executor.ts so that both sdk-executor.ts and
 * stream-adapter.ts can share the SteeringQueue class. The class implements
 * the AsyncIterable<SdkUserMessage> interface consumed by the SDK query()
 * prompt parameter.
 *
 * This is a pure data/logic module with no side effects — all supervision
 * concerns are managed by the callers (sdk-executor.ts and stream-adapter.ts).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** SDKUserMessage shape for steering queue entries. */
export interface SdkUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
  priority: "now" | "next" | "later";
  session_id: string;
  parent_tool_use_id: string | null;
}

// ─── SteeringQueue ──────────────────────────────────────────────────────────

/**
 * Async generator queue that delivers the initial unit prompt and subsequent
 * steering messages (wrapup warnings, idle recovery) into the SDK `query()`
 * AsyncIterable prompt channel.
 *
 * The SDK's `query()` function accepts `AsyncIterable<SDKUserMessage>` as its
 * prompt. This class implements that interface — it yields the initial prompt
 * first, then blocks waiting for `push()` calls from supervision timers. When
 * the query completes, `close()` is called to end iteration cleanly.
 *
 * Pitfall 2 prevention: `close()` MUST be called in the `finally` block after
 * the `for await` loop over the query. Failing to do so leaves the generator
 * hanging indefinitely.
 */
export class SteeringQueue {
  private readonly initialPrompt: string;
  private queue: SdkUserMessage[] = [];
  private resolve: (() => void) | null = null;
  private done = false;

  constructor(initialPrompt: string) {
    this.initialPrompt = initialPrompt;
  }

  /**
   * Push a steering message into the queue.
   * The message will be yielded to the SDK query on its next turn.
   * Must only be called while the for-await loop is running.
   */
  push(message: SdkUserMessage): void {
    this.queue.push(message);
    this.resolve?.();
    this.resolve = null;
  }

  /**
   * Signal end of the steering channel.
   * Called in the `finally` block after the query loop completes.
   * After `close()`, the async iterator terminates cleanly.
   */
  close(): void {
    this.done = true;
    this.resolve?.();
    this.resolve = null;
  }

  /**
   * Async iterator implementation for the SDK prompt channel.
   *
   * Yields the initial prompt first (to start the SDK agent), then blocks
   * waiting for push() calls until close() is called.
   *
   * The initial message uses priority "now" to immediately start the unit.
   * Steering messages use whatever priority was set by the caller (typically "now").
   *
   * The try/finally ensures that if the consumer breaks from the for-await loop
   * (calling .return() on the iterator), any pending Promise<void> waiting inside
   * the generator is properly cleaned up, preventing memory leaks and test warnings
   * about unresolved promises.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<SdkUserMessage> {
    // Yield the initial unit prompt as the first message
    yield {
      type: "user",
      message: { role: "user", content: this.initialPrompt },
      priority: "now",
      session_id: "",
      parent_tool_use_id: null,
    };

    // Yield queued messages, then block until more arrive or queue closes.
    // try/finally ensures cleanup when the consumer calls .return() (e.g., break).
    try {
      while (true) {
        while (this.queue.length > 0) {
          yield this.queue.shift()!;
        }
        if (this.done) return;
        // Block until push() or close() resolves the promise
        await new Promise<void>(r => { this.resolve = r; });
      }
    } finally {
      // Clear the resolve reference to allow GC and prevent stale callbacks
      this.resolve = null;
    }
  }
}

// ─── Wrapup warning content ─────────────────────────────────────────────────

/**
 * Wrapup warning text pushed to the steering queue at soft timeout.
 * Content is identical to the Pi path (auto.ts lines 2877-2885) — verbatim copy.
 */
export const WRAPUP_WARNING_TEXT = [
  "**TIME BUDGET WARNING — keep going only if progress is real.**",
  "This unit crossed the soft time budget.",
  "If you are making progress, continue. If not, switch to wrap-up mode now:",
  "1. rerun the minimal required verification",
  "2. write or update the required durable artifacts",
  "3. mark task or slice state on disk correctly",
  "4. leave precise resume notes if anything remains unfinished",
].join("\n");
