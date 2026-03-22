import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	StatusActivityManager,
	type StatusActivityRenderer,
} from "../../packages/pi-coding-agent/src/modes/interactive/status-activity-manager.ts";

class FakeRenderer implements StatusActivityRenderer {
	events: Array<{ type: "start" | "update" | "stop"; message?: string }> = [];

	start(message: string): void {
		this.events.push({ type: "start", message });
	}

	update(message: string): void {
		this.events.push({ type: "update", message });
	}

	stop(): void {
		this.events.push({ type: "stop" });
	}
}

describe("StatusActivityManager", () => {
	it("starts with default message and stops when handle stops", () => {
		const renderer = new FakeRenderer();
		const manager = new StatusActivityManager(renderer, () => "Working...");

		const handle = manager.start();
		assert.equal(handle.isActive(), true);
		assert.deepEqual(renderer.events, [{ type: "start", message: "Working..." }]);

		handle.stop();
		assert.equal(handle.isActive(), false);
		assert.deepEqual(renderer.events, [{ type: "start", message: "Working..." }, { type: "stop" }]);
	});

	it("applies queued working message to next started activity", () => {
		const renderer = new FakeRenderer();
		const manager = new StatusActivityManager(renderer, () => "Working...");

		manager.setWorkingMessage("Installing extension...");
		const handle = manager.start();
		assert.deepEqual(renderer.events, [{ type: "start", message: "Installing extension..." }]);

		handle.stop();
		assert.deepEqual(renderer.events, [{ type: "start", message: "Installing extension..." }, { type: "stop" }]);
	});

	it("setWorkingMessage updates active activity and restores default when cleared", () => {
		const renderer = new FakeRenderer();
		const manager = new StatusActivityManager(renderer, () => "Working...");

		const handle = manager.start();
		manager.setWorkingMessage("Checking runtime...");
		manager.setWorkingMessage(undefined);

		assert.deepEqual(renderer.events, [
			{ type: "start", message: "Working..." },
			{ type: "update", message: "Checking runtime..." },
			{ type: "update", message: "Working..." },
		]);

		handle.stop();
	});

	it("nested activities restore previous message when top activity stops", () => {
		const renderer = new FakeRenderer();
		const manager = new StatusActivityManager(renderer, () => "Working...");

		const outer = manager.start({ message: "Outer work" });
		const inner = manager.start({ message: "Inner work" });

		inner.stop();
		outer.stop();

		assert.deepEqual(renderer.events, [
			{ type: "start", message: "Outer work" },
			{ type: "update", message: "Inner work" },
			{ type: "update", message: "Outer work" },
			{ type: "stop" },
		]);
	});

	it("run() cleans up activity on error", async () => {
		const renderer = new FakeRenderer();
		const manager = new StatusActivityManager(renderer, () => "Working...");

		await assert.rejects(
			manager.run(
				async () => {
					throw new Error("boom");
				},
				{ message: "Running..." },
			),
			{ message: "boom" },
		);

		assert.deepEqual(renderer.events, [{ type: "start", message: "Running..." }, { type: "stop" }]);
	});
});
