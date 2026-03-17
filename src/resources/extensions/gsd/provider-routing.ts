import { AuthStorage } from "@gsd/pi-coding-agent";

export interface ProviderRoutingDecision {
	provider: "pi" | "claude-code";
	/** Diagnostic reason for this routing decision. */
	reason: string;
}

/**
 * Determine which execution backend to use based on auth credentials.
 *
 * Reads auth.json via AuthStorage (or accepts an AuthStorage instance directly
 * for testability) and checks for a `type: "claude-code"` credential under the
 * "claude-code" key.
 *
 * @param authOrPath - Path to auth.json, an existing AuthStorage instance, or
 *   undefined to use the default ~/.gsd/agent/auth.json path.
 * @returns Routing decision with provider identifier and diagnostic reason.
 */
export function resolveProviderRouting(
	authOrPath?: string | AuthStorage,
): ProviderRoutingDecision {
	const auth =
		typeof authOrPath === "string" || authOrPath === undefined
			? AuthStorage.create(authOrPath)
			: authOrPath;

	const cred = auth.get("claude-code");
	if (cred?.type === "claude-code") {
		return {
			provider: "claude-code",
			reason: "claude-code credential found in auth.json",
		};
	}

	return {
		provider: "pi",
		reason: "no claude-code credential — using Pi provider",
	};
}
