import type { AssistantMessage } from "@gsd/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@gsd/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { formatActionTimestamp, formatTimestamp, type TimestampFormat } from "./timestamp.js";

type VisibleAssistantBlock = {
	kind: "text" | "thinking";
	text: string;
	timestamp: number;
};

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private lastMessage?: AssistantMessage;
	private timestampFormat: TimestampFormat;
	private contentTimestamps = new Map<number, number>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		timestampFormat: TimestampFormat = "date-time-iso",
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.timestampFormat = timestampFormat;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();

		const visibleBlocks: VisibleAssistantBlock[] = [];
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				if (!this.contentTimestamps.has(i)) {
					this.contentTimestamps.set(i, Date.now());
				}
				const ts = this.contentTimestamps.get(i) ?? Date.now();
				const merged = visibleBlocks[visibleBlocks.length - 1];
				const tsKey = formatActionTimestamp(ts);
				const mergedTsKey = merged ? formatActionTimestamp(merged.timestamp) : undefined;
				if (merged && merged.kind === "text" && mergedTsKey === tsKey) {
					merged.text += `\n\n${content.text.trim()}`;
				} else {
					visibleBlocks.push({ kind: "text", text: content.text.trim(), timestamp: ts });
				}
			} else if (content.type === "thinking" && content.thinking.trim()) {
				if (!this.contentTimestamps.has(i)) {
					this.contentTimestamps.set(i, Date.now());
				}
				const ts = this.contentTimestamps.get(i) ?? Date.now();
				const merged = visibleBlocks[visibleBlocks.length - 1];
				const tsKey = formatActionTimestamp(ts);
				const mergedTsKey = merged ? formatActionTimestamp(merged.timestamp) : undefined;
				if (merged && merged.kind === "thinking" && mergedTsKey === tsKey) {
					merged.text += `\n\n${content.thinking.trim()}`;
				} else {
					visibleBlocks.push({ kind: "thinking", text: content.thinking.trim(), timestamp: ts });
				}
			}
		}

		const hasVisibleContent = visibleBlocks.length > 0;

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order (timestamps intentionally hidden for cleaner timeline).
		for (let i = 0; i < visibleBlocks.length; i++) {
			const block = visibleBlocks[i];
			const prefix =
				block.kind === "text"
					? theme.fg("accent", theme.bold("[reply]"))
					: theme.fg("thinkingText", theme.bold("[think]"));
			this.contentContainer.addChild(new Text(prefix, 1, 0));

			const hasVisibleContentAfter = i < visibleBlocks.length - 1;

			if (block.kind === "text") {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(new Markdown(block.text.trim(), 1, 0, this.markdownTheme));
			} else if (this.hideThinkingBlock) {
				// Show static "Thinking..." label when hidden
				this.contentContainer.addChild(new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 1, 0));
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			} else {
				// Thinking traces in thinkingText color, italic
				this.contentContainer.addChild(
					new Markdown(block.text.trim(), 1, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					}),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}

		// Show timestamp when the message is complete (has a stop reason)
		if (message.stopReason && message.timestamp) {
			const timeStr = formatTimestamp(message.timestamp, this.timestampFormat);
			this.contentContainer.addChild(new Text(theme.fg("dim", timeStr), 1, 0));
		}
	}
}
