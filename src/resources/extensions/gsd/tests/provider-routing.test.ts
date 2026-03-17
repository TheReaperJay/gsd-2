import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuthStorage } from "@gsd/pi-coding-agent";

import {
	resolveProviderRouting,
	type ProviderRoutingDecision,
} from "../provider-routing.js";

describe("resolveProviderRouting", () => {
	it("returns { provider: 'claude-code' } when auth has a claude-code credential", () => {
		const auth = AuthStorage.inMemory({ "claude-code": { type: "claude-code" } });
		const decision: ProviderRoutingDecision = resolveProviderRouting(auth);
		assert.equal(decision.provider, "claude-code");
		assert.ok(typeof decision.reason === "string" && decision.reason.length > 0);
	});

	it("returns { provider: 'pi' } when auth has no credentials", () => {
		const auth = AuthStorage.inMemory({});
		const decision = resolveProviderRouting(auth);
		assert.equal(decision.provider, "pi");
		assert.ok(typeof decision.reason === "string" && decision.reason.length > 0);
	});

	it("returns { provider: 'pi' } when auth has only api_key credentials", () => {
		const auth = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "sk-test" },
		});
		const decision = resolveProviderRouting(auth);
		assert.equal(decision.provider, "pi");
	});

	it("exports ProviderRoutingDecision type (structural check)", () => {
		const auth = AuthStorage.inMemory({});
		const decision = resolveProviderRouting(auth);
		// ProviderRoutingDecision must have provider and reason fields
		assert.ok("provider" in decision, "decision must have provider field");
		assert.ok("reason" in decision, "decision must have reason field");
		assert.ok(
			decision.provider === "pi" || decision.provider === "claude-code",
			"provider must be pi or claude-code",
		);
	});
});
