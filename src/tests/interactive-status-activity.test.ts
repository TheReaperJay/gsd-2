import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..", "..");

const extensionUiController = readFileSync(
	join(root, "packages/pi-coding-agent/src/modes/interactive/controllers/extension-ui-controller.ts"),
	"utf-8",
);
const chatController = readFileSync(
	join(root, "packages/pi-coding-agent/src/modes/interactive/controllers/chat-controller.ts"),
	"utf-8",
);
const interactiveMode = readFileSync(
	join(root, "packages/pi-coding-agent/src/modes/interactive/interactive-mode.ts"),
	"utf-8",
);
const rpcMode = readFileSync(
	join(root, "packages/pi-coding-agent/src/modes/rpc/rpc-mode.ts"),
	"utf-8",
);

describe("status activity integration", () => {
	it("extension UI context exposes startActivity/runActivity and setWorkingMessage hooks", () => {
		assert.ok(
			extensionUiController.includes("startActivity: (message) => host.startStatusActivity({ message })"),
		);
		assert.ok(
			extensionUiController.includes("runActivity: (operation, message) => host.runStatusActivity(operation, { message })"),
		);
		assert.ok(extensionUiController.includes("setWorkingMessage: (message) => host.statusActivity.setWorkingMessage(message)"));
	});

	it("agent lifecycle uses status activity helpers in chat controller", () => {
		assert.ok(chatController.includes("host.agentStatusActivity = host.startStatusActivity()"));
		assert.ok(chatController.includes("host.agentStatusActivity?.stop()"));
	});

	it("interactive mode routes prompts through promptWithStatusActivity", () => {
		assert.ok(interactiveMode.includes("private async promptWithStatusActivity(text: string, options?: PromptOptions): Promise<void>"));
		assert.ok(interactiveMode.includes("await this.promptWithStatusActivity(userInput);"));
		assert.ok(interactiveMode.includes("await this.promptWithStatusActivity(text, { streamingBehavior: \"followUp\" });"));
	});

	it("RPC mode provides no-op activity helpers", () => {
		assert.ok(rpcMode.includes("startActivity(): { update: () => void; stop: () => void; isActive: () => boolean }"));
		assert.ok(rpcMode.includes("runActivity<T>(operation: () => Promise<T>): Promise<T>"));
	});
});
