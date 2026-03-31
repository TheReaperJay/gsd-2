import { Loader, Spacer, Text } from "@gsd/pi-tui";

import type { InteractiveModeEvent, InteractiveModeStateHost } from "../interactive-mode-state.js";
import { AssistantMessageComponent } from "../components/assistant-message.js";
import { appKey } from "../components/keybinding-hints.js";
import { ToolExecutionComponent } from "../components/tool-execution.js";
import { type TurnSummaryComponent, type TurnSummaryMetrics } from "../components/turn-summary.js";
import { theme } from "../theme/theme.js";

function parseDiffLineCounts(diff: unknown): { added: number; removed: number } {
	if (typeof diff !== "string" || diff.length === 0) {
		return { added: 0, removed: 0 };
	}
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) {
			added += 1;
		} else if (line.startsWith("-")) {
			removed += 1;
		}
	}
	return { added, removed };
}

function findThinkingOutputTokens(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as Record<string, unknown>;
	const candidates = [
		u.reasoningOutputTokens,
		u.thinkingOutputTokens,
		u.reasoning_tokens,
		u.thinking_tokens,
		u.outputReasoningTokens,
		u.output_thinking_tokens,
	];
	for (const value of candidates) {
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			return value;
		}
	}
	return undefined;
}

function updateSummaryMetrics(
	host: InteractiveModeStateHost & {
		streamingSummaryComponent?: TurnSummaryComponent;
		currentTurnMetrics?: TurnSummaryMetrics;
	},
	update: Partial<TurnSummaryMetrics>,
): void {
	if (!host.currentTurnMetrics) return;
	host.currentTurnMetrics = { ...host.currentTurnMetrics, ...update };
	host.streamingSummaryComponent?.updateMetrics(host.currentTurnMetrics);
}

function applyUsageToSummary(
	host: InteractiveModeStateHost & {
		currentTurnMetrics?: TurnSummaryMetrics;
		streamingSummaryComponent?: TurnSummaryComponent;
	},
	usage: unknown,
): void {
	if (!host.currentTurnMetrics || !usage || typeof usage !== "object") return;
	const usageObj = usage as Record<string, unknown>;
	const inputTokens = typeof usageObj.input === "number" ? usageObj.input : undefined;
	const outputTokens = typeof usageObj.output === "number" ? usageObj.output : undefined;
	const thinkingOutputTokens = findThinkingOutputTokens(usageObj);
	const normalOutputTokens =
		typeof outputTokens === "number" && typeof thinkingOutputTokens === "number"
			? Math.max(0, outputTokens - thinkingOutputTokens)
			: outputTokens;

	updateSummaryMetrics(host, { inputTokens, outputTokens, thinkingOutputTokens, normalOutputTokens });
}

function pinSummaryToBottom(host: InteractiveModeStateHost & { streamingSummaryComponent?: TurnSummaryComponent }): void {
	// Summary row rendering is disabled in chat/status panes.
	void host;
}

export async function handleAgentEvent(host: InteractiveModeStateHost & {
	init: () => Promise<void>;
	getMarkdownThemeWithSettings: () => any;
	addMessageToChat: (message: any, options?: any) => void;
	formatWebSearchResult: (content: unknown) => string;
	getRegisteredToolDefinition: (toolName: string) => any;
	checkShutdownRequested: () => Promise<void>;
	rebuildChatFromMessages: () => void;
	flushCompactionQueue: (options?: { willRetry?: boolean }) => Promise<void>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	updatePendingMessagesDisplay: () => void;
	updateTerminalTitle: () => void;
	updateEditorBorderColor: () => void;
	pendingMessagesContainer: { clear: () => void };
	streamingSummaryComponent?: TurnSummaryComponent;
	currentTurnMetrics?: TurnSummaryMetrics;
}, event: InteractiveModeEvent): Promise<void> {
	if (!host.isInitialized) {
		await host.init();
	}

	host.footer.invalidate();

	switch (event.type) {
		case "session_state_changed":
			switch (event.reason) {
				case "new_session":
				case "switch_session":
				case "fork":
					host.streamingComponent = undefined;
					host.streamingMessage = undefined;
					host.streamingSummaryComponent?.dispose?.();
					host.streamingSummaryComponent = undefined;
					host.currentTurnMetrics = undefined;
					host.pendingTools.clear();
					host.pendingMessagesContainer.clear();
					host.compactionQueuedMessages = [];
					host.rebuildChatFromMessages();
					host.updatePendingMessagesDisplay();
					host.updateTerminalTitle();
					host.updateEditorBorderColor();
					host.ui.requestRender();
					return;
				case "set_session_name":
					host.updateTerminalTitle();
					host.ui.requestRender();
					return;
				case "set_model":
				case "set_thinking_level":
					host.updateEditorBorderColor();
					host.ui.requestRender();
					return;
				default:
					host.ui.requestRender();
					return;
			}

		case "agent_start":
			if (host.retryEscapeHandler) {
				host.defaultEditor.onEscape = host.retryEscapeHandler;
				host.retryEscapeHandler = undefined;
			}
			if (host.retryLoader) {
				host.retryLoader.stop();
				host.retryLoader = undefined;
			}
			if (host.loadingAnimation) {
				host.loadingAnimation.stop();
			}
			host.statusContainer.clear();
			host.loadingAnimation = new Loader(
				host.ui,
				(spinner) => theme.fg("accent", spinner),
				(text) => theme.fg("muted", text),
				host.defaultWorkingMessage,
			);
			host.statusContainer.addChild(host.loadingAnimation);
			if (host.pendingWorkingMessage !== undefined) {
				if (host.pendingWorkingMessage) {
					host.loadingAnimation.setMessage(host.pendingWorkingMessage);
				}
				host.pendingWorkingMessage = undefined;
			}
			host.ui.requestRender();
			break;

		case "message_start":
			if (event.message.role === "custom") {
				host.addMessageToChat(event.message);
				host.ui.requestRender();
			} else if (event.message.role === "user") {
				host.addMessageToChat(event.message);
				host.updatePendingMessagesDisplay();
				host.ui.requestRender();
			} else if (event.message.role === "assistant") {
				host.streamingComponent = new AssistantMessageComponent(
					undefined,
					host.hideThinkingBlock,
					host.getMarkdownThemeWithSettings(),
					host.settingsManager.getTimestampFormat(),
				);
				host.streamingMessage = event.message;
				host.currentTurnMetrics = {
					startMs: Date.now(),
					toolUses: 0,
					linesAdded: 0,
					linesRemoved: 0,
					status: "running",
				};
				host.chatContainer.addChild(host.streamingComponent);
				host.streamingComponent.updateContent(host.streamingMessage);
				host.ui.requestRender();
			}
			break;

		case "message_update":
			if (host.streamingComponent && event.message.role === "assistant") {
				host.streamingMessage = event.message;
				host.streamingComponent.updateContent(host.streamingMessage);
				for (const content of host.streamingMessage.content) {
					if (content.type === "toolCall") {
						if (!host.pendingTools.has(content.id)) {
							const component = new ToolExecutionComponent(
								content.name,
								content.arguments,
								{ showImages: host.settingsManager.getShowImages() },
								host.getRegisteredToolDefinition(content.name),
								host.ui,
							);
								component.setExpanded(host.toolOutputExpanded);
								host.chatContainer.addChild(component);
								host.pendingTools.set(content.id, component);
								host.setActiveExpandable(component);
								updateSummaryMetrics(host, { toolUses: (host.currentTurnMetrics?.toolUses ?? 0) + 1 });
								pinSummaryToBottom(host);
						} else {
							host.pendingTools.get(content.id)?.updateArgs(content.arguments);
						}
					} else if (content.type === "serverToolUse") {
						if (!host.pendingTools.has(content.id)) {
							const component = new ToolExecutionComponent(
								content.name,
								content.input ?? {},
								{ showImages: host.settingsManager.getShowImages() },
								undefined,
								host.ui,
							);
								component.setExpanded(host.toolOutputExpanded);
								host.chatContainer.addChild(component);
								host.pendingTools.set(content.id, component);
								host.setActiveExpandable(component);
								updateSummaryMetrics(host, { toolUses: (host.currentTurnMetrics?.toolUses ?? 0) + 1 });
								pinSummaryToBottom(host);
						}
					} else if (content.type === "webSearchResult") {
						const component = host.pendingTools.get(content.toolUseId);
						if (component) {
							if (process.env.PI_OFFLINE === "1") {
								component.updateResult({
									content: [{ type: "text", text: "Web search disabled (offline mode)" }],
									isError: false,
								});
							} else {
								const searchContent = content.content;
								const isError = searchContent &&
									typeof searchContent === "object" &&
									"type" in (searchContent as any) &&
									(searchContent as any).type === "web_search_tool_result_error";
								component.updateResult({
									content: [{ type: "text", text: host.formatWebSearchResult(searchContent) }],
									isError: !!isError,
								});
							}
						}
					}
				}
				applyUsageToSummary(host, host.streamingMessage.usage);
				pinSummaryToBottom(host);
				host.ui.requestRender();
			}
			break;

		case "message_end":
			if (event.message.role === "user") break;
			if (host.streamingComponent && event.message.role === "assistant") {
				host.streamingMessage = event.message;
				let errorMessage: string | undefined;
				if (host.streamingMessage.stopReason === "aborted") {
					const retryAttempt = host.session.retryAttempt;
					errorMessage = retryAttempt > 0
						? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
						: "Operation aborted";
					host.streamingMessage.errorMessage = errorMessage;
				}
				host.streamingComponent.updateContent(host.streamingMessage);
				applyUsageToSummary(host, host.streamingMessage.usage);
				updateSummaryMetrics(host, {
					endMs: Date.now(),
					status:
						host.streamingMessage.stopReason === "error"
							? "error"
							: host.streamingMessage.stopReason === "aborted"
								? "aborted"
								: "done",
				});
				if (host.streamingMessage.stopReason === "aborted" || host.streamingMessage.stopReason === "error") {
					if (!errorMessage) {
						errorMessage = host.streamingMessage.errorMessage || "Error";
					}
					for (const [, component] of host.pendingTools.entries()) {
						component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
					}
					host.pendingTools.clear();
				} else {
					for (const [, component] of host.pendingTools.entries()) {
						component.setArgsComplete();
					}
				}
				pinSummaryToBottom(host);
				host.streamingComponent = undefined;
				host.streamingMessage = undefined;
				host.streamingSummaryComponent = undefined;
				host.currentTurnMetrics = undefined;
				host.footer.invalidate();
			}
			host.ui.requestRender();
			break;

		case "tool_execution_start":
			if (!host.pendingTools.has(event.toolCallId)) {
				const component = new ToolExecutionComponent(
					event.toolName,
					event.args,
					{ showImages: host.settingsManager.getShowImages() },
					host.getRegisteredToolDefinition(event.toolName),
					host.ui,
				);
				component.setExpanded(host.toolOutputExpanded);
				host.chatContainer.addChild(component);
				host.pendingTools.set(event.toolCallId, component);
				host.setActiveExpandable(component);
				updateSummaryMetrics(host, { toolUses: (host.currentTurnMetrics?.toolUses ?? 0) + 1 });
				pinSummaryToBottom(host);
				host.ui.requestRender();
			}
			break;

		case "tool_execution_update": {
			const component = host.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.partialResult, isError: false }, true);
				host.ui.requestRender();
			}
			break;
		}

		case "tool_execution_end": {
			const component = host.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.result, isError: event.isError });
				const diffCounts = parseDiffLineCounts((event.result as any)?.details?.diff);
				updateSummaryMetrics(host, {
					linesAdded: (host.currentTurnMetrics?.linesAdded ?? 0) + diffCounts.added,
					linesRemoved: (host.currentTurnMetrics?.linesRemoved ?? 0) + diffCounts.removed,
				});
				host.pendingTools.delete(event.toolCallId);
				pinSummaryToBottom(host);
				host.ui.requestRender();
			}
			break;
		}

		case "agent_end":
			if (host.loadingAnimation) {
				host.loadingAnimation.stop();
				host.loadingAnimation = undefined;
				host.statusContainer.clear();
			}
			if (host.streamingComponent) {
				host.chatContainer.removeChild(host.streamingComponent);
				host.streamingComponent = undefined;
				host.streamingMessage = undefined;
			}
			host.streamingSummaryComponent = undefined;
			host.currentTurnMetrics = undefined;
			host.pendingTools.clear();
			await host.checkShutdownRequested();
			host.ui.requestRender();
			break;

		case "auto_compaction_start":
			host.autoCompactionEscapeHandler = host.defaultEditor.onEscape;
			host.defaultEditor.onEscape = () => host.session.abortCompaction();
			host.statusContainer.clear();
			host.autoCompactionLoader = new Loader(
				host.ui,
				(spinner) => theme.fg("accent", spinner),
				(text) => theme.fg("muted", text),
				`${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... (${appKey(host.keybindings, "interrupt")} to cancel)`,
			);
			host.statusContainer.addChild(host.autoCompactionLoader);
			host.ui.requestRender();
			break;

		case "auto_compaction_end":
			if (host.autoCompactionEscapeHandler) {
				host.defaultEditor.onEscape = host.autoCompactionEscapeHandler;
				host.autoCompactionEscapeHandler = undefined;
			}
			if (host.autoCompactionLoader) {
				host.autoCompactionLoader.stop();
				host.autoCompactionLoader = undefined;
				host.statusContainer.clear();
			}
			if (event.aborted) {
				host.showStatus("Auto-compaction cancelled");
			} else if (event.result) {
				host.chatContainer.clear();
				host.rebuildChatFromMessages();
				host.addMessageToChat({
					role: "compactionSummary",
					tokensBefore: event.result.tokensBefore,
					summary: event.result.summary,
					timestamp: Date.now(),
				});
				host.footer.invalidate();
			} else if (event.errorMessage) {
				host.chatContainer.addChild(new Spacer(1));
				host.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
			}
			void host.flushCompactionQueue({ willRetry: event.willRetry });
			host.ui.requestRender();
			break;

		case "auto_retry_start":
			host.retryEscapeHandler = host.defaultEditor.onEscape;
			host.defaultEditor.onEscape = () => host.session.abortRetry();
			host.statusContainer.clear();
			host.retryLoader = new Loader(
				host.ui,
				(spinner) => theme.fg("warning", spinner),
				(text) => theme.fg("muted", text),
				`Retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s... (${appKey(host.keybindings, "interrupt")} to cancel)`,
			);
			host.statusContainer.addChild(host.retryLoader);
			host.ui.requestRender();
			break;

		case "auto_retry_end":
			if (host.retryEscapeHandler) {
				host.defaultEditor.onEscape = host.retryEscapeHandler;
				host.retryEscapeHandler = undefined;
			}
			if (host.retryLoader) {
				host.retryLoader.stop();
				host.retryLoader = undefined;
				host.statusContainer.clear();
			}
			if (!event.success) {
				host.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
			}
			host.ui.requestRender();
			break;

		case "fallback_provider_switch":
			host.showStatus(`Switched from ${event.from} → ${event.to} (${event.reason})`);
			host.ui.requestRender();
			break;

		case "fallback_provider_restored":
			host.showStatus(`Restored to ${event.provider}`);
			host.ui.requestRender();
			break;

		case "fallback_chain_exhausted":
			host.showError(event.reason);
			host.ui.requestRender();
			break;

		case "image_overflow_recovery":
			host.showStatus(
				`Removed ${event.strippedCount} older image(s) to comply with API limits. Retrying...`,
			);
			host.ui.requestRender();
			break;
	}
}
