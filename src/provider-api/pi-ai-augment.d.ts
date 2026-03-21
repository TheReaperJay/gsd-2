/**
 * Module augmentation for @gsd/pi-ai.
 *
 * @gsd/pi-ai's types.ts re-exports AssistantMessageEventStream as
 * `export type`, which erases the class value from the module's public
 * type surface. The class IS exported as a value from utils/event-stream.ts
 * via `export *` in index.ts — this augmentation restores that visibility
 * so external code can instantiate it.
 */

import type { AssistantMessageEvent, AssistantMessage } from "@gsd/pi-ai";

declare module "@gsd/pi-ai" {
  class AssistantMessageEventStream {
    push(event: AssistantMessageEvent): void;
    end(): void;
    result(): Promise<AssistantMessage>;
    [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
  }
}
