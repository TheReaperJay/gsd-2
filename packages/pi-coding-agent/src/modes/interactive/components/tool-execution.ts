import {
	Box,
	Container,
	getCapabilities,
	Image,
	imageFallback,
	Spacer,
	Text,
	type TUI,
} from "@gsd/pi-tui";
import stripAnsi from "strip-ansi";
import type { ToolDefinition } from "../../../core/extensions/types.js";
import { computeEditDiff, type EditDiffError, type EditDiffResult } from "../../../core/tools/edit-diff.js";
import { allTools } from "../../../core/tools/index.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../../../core/tools/truncate.js";
import { convertToPng } from "../../../utils/image-convert.js";
import { sanitizeBinaryOutput } from "../../../utils/shell.js";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";
import { shortenPath } from "../utils/shorten-path.js";
import { renderDiff } from "./diff.js";
import { keyHint } from "./keybinding-hints.js";
// During partial write tool-call streaming, re-highlight the first N lines fully
// to keep multiline tokenization mostly correct without re-highlighting the full file.
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

/**
 * Replace tabs with spaces for consistent rendering
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Normalize control characters for terminal preview rendering.
 * Keep tool arguments unchanged, sanitize only display text.
 */
function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

/** Safely coerce value to string for display. Returns null if invalid type. */
function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null; // Invalid type
}

function canonicalizeToolName(name: string): string {
	return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function formatToolDisplayName(name: string): string {
	if (!name.trim()) return "Tool";
	return name
		.trim()
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
		.join(" ");
}

function truncateCommandPreview(command: string, maxChars = 90): string {
	if (command.length <= maxChars) return command;
	return `${command.slice(0, Math.max(0, maxChars - 3))}...`;
}

export interface ToolExecutionOptions {
	showImages?: boolean; // default: true (only used if terminal supports images)
}

export interface ToolMenuSnapshot {
	label: string;
	status: string;
	expanded: boolean;
	previewLines: string[];
	totalPreviewLines: number;
}

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private contentBox: Box; // Used for custom tools and bash visual truncation
	private contentText: Text; // For built-in tools (with its own padding/bg)
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private readonly toolDisplayName: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private isPartial = true;
	private toolDefinition?: ToolDefinition;
	private ui: TUI;
	private cwd: string;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	// Cached edit diff preview (computed when args arrive, before tool executes)
	private editDiffPreview?: EditDiffResult | EditDiffError;
	private editDiffArgsKey?: string; // Track which args the preview is for
	// Cached converted images for Kitty protocol (which requires PNG), keyed by index
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	// Incremental syntax highlighting cache for write tool call args
	private writeHighlightCache?: WriteHighlightCache;
	// When true, this component intentionally renders no lines
	private hideComponent = false;

	constructor(
		toolName: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition | undefined,
		ui: TUI,
		cwd: string = process.cwd(),
	) {
		super();
		this.toolName = canonicalizeToolName(toolName);
		this.toolDisplayName = formatToolDisplayName(toolName);
		this.args = args;
		this.showImages = options.showImages ?? true;
		this.toolDefinition = toolDefinition;
		this.ui = ui;
		this.cwd = cwd;

		// Always create both - contentBox for custom tools/bash, contentText for other built-ins
		this.contentBox = new Box(0, 0, (text: string) => text);
		this.contentText = new Text("", 0, 0, (text: string) => text);

		// Use contentBox for bash (visual truncation) or custom tools with custom renderers
		// Use contentText for built-in tools (including overrides without custom renderers)
		if (this.toolName === "bash" || (toolDefinition && !this.shouldUseBuiltInRenderer())) {
			this.addChild(this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	/**
	 * Check if we should use built-in rendering for this tool.
	 * Returns true if the tool name is a built-in AND either there's no toolDefinition
	 * or the toolDefinition doesn't provide custom renderers.
	 */
	private shouldUseBuiltInRenderer(): boolean {
		const isBuiltInName = this.toolName in allTools;
		const hasCustomRenderers = this.toolDefinition?.renderCall || this.toolDefinition?.renderResult;
		return isBuiltInName && !hasCustomRenderers;
	}

	updateArgs(args: any): void {
		this.args = args;
		if (this.toolName === "write" && this.isPartial) {
			this.updateWriteHighlightCacheIncremental();
		}
		this.updateDisplay();
	}

	private highlightSingleLine(line: string, lang: string): string {
		const highlighted = highlightCode(line, lang);
		return highlighted[0] ?? "";
	}

	private refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
		const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
		if (prefixCount === 0) return;

		const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
		const prefixHighlighted = highlightCode(prefixSource, cache.lang);
		for (let i = 0; i < prefixCount; i++) {
			cache.highlightedLines[i] =
				prefixHighlighted[i] ?? this.highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
		}
	}

	private rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): void {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		if (!lang) {
			this.writeHighlightCache = undefined;
			return;
		}

		const displayContent = normalizeDisplayText(fileContent);
		const normalized = replaceTabs(displayContent);
		this.writeHighlightCache = {
			rawPath,
			lang,
			rawContent: fileContent,
			normalizedLines: normalized.split("\n"),
			highlightedLines: highlightCode(normalized, lang),
		};
	}

	private updateWriteHighlightCacheIncremental(): void {
		const rawPath = str(this.args?.file_path ?? this.args?.path);
		const fileContent = str(this.args?.content);
		if (rawPath === null || fileContent === null) {
			this.writeHighlightCache = undefined;
			return;
		}

		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		if (!lang) {
			this.writeHighlightCache = undefined;
			return;
		}

		if (!this.writeHighlightCache) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		const cache = this.writeHighlightCache;
		if (cache.lang !== lang || cache.rawPath !== rawPath) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		if (!fileContent.startsWith(cache.rawContent)) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		if (fileContent.length === cache.rawContent.length) {
			return;
		}

		const deltaRaw = fileContent.slice(cache.rawContent.length);
		const deltaDisplay = normalizeDisplayText(deltaRaw);
		const deltaNormalized = replaceTabs(deltaDisplay);
		cache.rawContent = fileContent;

		if (cache.normalizedLines.length === 0) {
			cache.normalizedLines.push("");
			cache.highlightedLines.push("");
		}

		const segments = deltaNormalized.split("\n");
		const lastIndex = cache.normalizedLines.length - 1;
		cache.normalizedLines[lastIndex] += segments[0];
		cache.highlightedLines[lastIndex] = this.highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);

		for (let i = 1; i < segments.length; i++) {
			cache.normalizedLines.push(segments[i]);
			cache.highlightedLines.push(this.highlightSingleLine(segments[i], cache.lang));
		}

		this.refreshWriteHighlightPrefix(cache);
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers diff computation for edit tool.
	 */
	setArgsComplete(): void {
		if (this.toolName === "write") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			if (rawPath !== null && fileContent !== null) {
				this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			}
		}
		this.maybeComputeEditDiff();
	}

	/**
	 * Compute edit diff preview when we have complete args.
	 * This runs async and updates display when done.
	 */
	private maybeComputeEditDiff(): void {
		if (this.toolName !== "edit") return;

		const path = this.args?.path;
		const oldText = this.args?.oldText;
		const newText = this.args?.newText;

		// Need all three params to compute diff
		if (!path || oldText === undefined || newText === undefined) return;

		// Create a key to track which args this computation is for
		const argsKey = JSON.stringify({ path, oldText, newText });

		// Skip if we already computed for these exact args
		if (this.editDiffArgsKey === argsKey) return;

		this.editDiffArgsKey = argsKey;

		// Compute diff async
		computeEditDiff(path, oldText, newText, this.cwd).then((result) => {
			// Only update if args haven't changed since we started
			if (this.editDiffArgsKey === argsKey) {
				this.editDiffPreview = result;
				this.updateDisplay();
				this.ui.requestRender();
			}
		});
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		if (this.toolName === "write" && !isPartial) {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			if (rawPath !== null && fileContent !== null) {
				this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			}
		}
		this.updateDisplay();
		// Convert non-PNG images to PNG for Kitty protocol (async)
		this.maybeConvertImagesForKitty();
	}

	/**
	 * Convert non-PNG images to PNG for Kitty graphics protocol.
	 * Kitty requires PNG format (f=100), so JPEG/GIF/WebP won't display.
	 */
	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		// Only needed for Kitty protocol
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			// Skip if already PNG or already converted
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			// Convert async
			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	getMenuSnapshot(maxPreviewLines = 12): ToolMenuSnapshot {
		let label = this.toolDisplayName;
		if (this.toolName === "bash") {
			const command = str(this.args?.command);
			const commandPreview =
				command === null ? "[invalid arg]" : command ? truncateCommandPreview(command, 84) : "...";
			label = `Bash: ${commandPreview}`;
		}

		const previewText = this.toolName === "bash" ? this.getBashOutput(str(this.args?.command)) : this.getTextOutput().trim();
		const lines = previewText ? previewText.split("\n") : [];
		return {
			label,
			status: this.getStatusPlain(),
			expanded: this.expanded,
			previewLines: lines.slice(0, maxPreviewLines),
			totalPreviewLines: lines.length,
		};
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		// Set background based on state
		const bgFn = (text: string) => text;

		const useBuiltInRenderer = this.shouldUseBuiltInRenderer();
		let customRendererHasContent = false;
		this.hideComponent = false;

		// Use built-in rendering for built-in tools (or overrides without custom renderers)
		if (useBuiltInRenderer) {
			if (this.toolName === "bash") {
				// Bash uses Box with visual line truncation
				this.contentBox.setBgFn(bgFn);
				this.contentBox.clear();
				this.renderBashContent();
			} else {
				// Other built-in tools: use Text directly with caching
				this.contentText.setCustomBgFn(bgFn);
				this.contentText.setText(this.formatToolExecution());
			}
		} else if (this.toolDefinition) {
			// Custom tools use Box for flexible component rendering
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();

			// Render call component
			if (this.toolDefinition.renderCall) {
				try {
					const callComponent = this.toolDefinition.renderCall(this.args, theme);
					if (callComponent !== undefined) {
						this.contentBox.addChild(callComponent);
						customRendererHasContent = true;
					}
				} catch {
					// Fall back to default on error
					this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolDisplayName)), 0, 0));
					customRendererHasContent = true;
				}
			} else {
				// No custom renderCall, show tool name
				this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolDisplayName)), 0, 0));
				customRendererHasContent = true;
			}

			// Render result component if we have a result
			if (this.result && this.toolDefinition.renderResult) {
				try {
					const resultComponent = this.toolDefinition.renderResult(
						{ content: this.result.content as any, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
					);
					if (resultComponent !== undefined) {
						this.contentBox.addChild(resultComponent);
						customRendererHasContent = true;
					}
				} catch {
					// Fall back to showing raw output on error
					const output = this.getTextOutput();
					if (output) {
						this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
						customRendererHasContent = true;
					}
				}
			} else if (this.result) {
				// Has result but no custom renderResult
				const output = this.getTextOutput();
				if (output) {
					this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
					customRendererHasContent = true;
				}
			}
		} else {
			// Unknown tool with no registered definition - show generic fallback
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
		}

		// Handle images (same for both custom and built-in)
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];
			const caps = getCapabilities();

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					// Use converted PNG for Kitty protocol if available
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;

					// For Kitty, skip non-PNG images that haven't been converted yet
					if (caps.images === "kitty" && imageMimeType !== "image/png") {
						continue;
					}

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: 60 },
					);
					imageComponent.setOnDimensionsResolved(() => {
						this.updateDisplay();
						this.ui.requestRender();
					});
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (!useBuiltInRenderer && this.toolDefinition) {
			this.hideComponent = !customRendererHasContent && this.imageComponents.length === 0;
		}
	}

	/**
	 * Render bash content using visual line truncation (like bash-execution.ts)
	 */
	private renderBashContent(): void {
		const command = str(this.args?.command);
		const timeout = this.args?.timeout as number | undefined;

		// Header
		const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
		const commandDisplay =
			command === null
				? theme.fg("error", "[invalid arg]")
				: command
					? theme.fg("toolOutput", truncateCommandPreview(command))
					: theme.fg("toolOutput", "...");
		const status = this.getBashStatusSuffix();
		const chevron = theme.fg("muted", this.expanded ? "▾" : "▸");
		const prefix = this.getActionPrefix();
		this.contentBox.addChild(
			new Text(
				prefix + theme.fg("toolTitle", theme.bold(`Bash: ${commandDisplay}`)) + timeoutSuffix + ` ${status} ${chevron}`,
				0,
				0,
			),
		);

		if (this.result && this.expanded) {
			const output = this.getBashOutput(command);

			if (output) {
				const outputPanel =
					theme.fg("muted", "┌ output") +
					"\n" +
					output
						.split("\n")
						.map((line) => `${theme.fg("muted", "│")} ${theme.fg("toolOutput", line)}`)
						.join("\n") +
					"\n" +
					theme.fg("muted", "└");
				this.contentBox.addChild(new Text(`\n${outputPanel}`, 0, 0));
			}

			// Truncation warnings
			const truncation = this.result.details?.truncation;
			const fullOutputPath = this.result.details?.fullOutputPath;
			if (truncation?.truncated || fullOutputPath) {
				const warnings: string[] = [];
				if (fullOutputPath) {
					warnings.push(`Full output: ${fullOutputPath}`);
				}
				if (truncation?.truncated) {
					if (truncation.truncatedBy === "lines") {
						warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
					} else {
						warnings.push(
							`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
						);
					}
				}
				this.contentBox.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
			}
		} else if (this.result && !this.expanded) {
			// Keep collapsed bash tools compact; output available via expand.
			const output = this.getBashOutput(command);
			if (output) {
				const lineCount = output.split("\n").length;
				const hint = theme.fg("muted", ` (${lineCount} lines hidden, ${keyHint("expandTools", "to expand")})`);
				this.contentBox.addChild(new Text(hint, 0, 0));
			}
		}
	}

	private getTextOutput(): string {
		if (!this.result) return "";

		const textBlocks = this.result.content?.filter((c: any) => c.type === "text") || [];
		const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

		let output = textBlocks
			.map((c: any) => {
				// Use sanitizeBinaryOutput to handle binary data that crashes string-width
				return sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "");
			})
			.join("\n");

		const caps = getCapabilities();
		if (imageBlocks.length > 0 && (!caps.images || !this.showImages)) {
			const imageIndicators = imageBlocks
				.map((img: any) => {
					return imageFallback(img.mimeType);
				})
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}

	private formatToolExecution(): string {
		let text = "";
		const invalidArg = theme.fg("error", "[invalid arg]");

		if (this.toolName === "read") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath) : null;
			const offset = this.args?.offset;
			const limit = this.args?.limit;

			let pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}

			text = `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`;

			if (this.result) {
				const rawOutput = this.getTextOutput();
				// Strip hashline prefixes (e.g. "1#BQ:content") for TUI display
				const output = rawOutput.replace(/^(\s*)\d+#[ZPMQVRWSNKTXJBYH]{2}:/gm, "$1");
				const rawPath = str(this.args?.file_path ?? this.args?.path);
				const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
				const lines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");

				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text +=
					"\n\n" +
					displayLines
						.map((line: string) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))))
						.join("\n");
				if (remaining > 0) {
					text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
				}

				const truncation = this.result.details?.truncation;
				if (truncation?.truncated) {
					if (truncation.firstLineExceedsLimit) {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`,
							);
					} else if (truncation.truncatedBy === "lines") {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`,
							);
					} else {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`,
							);
					}
				}
			}
		} else if (this.toolName === "write") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			const path = rawPath !== null ? shortenPath(rawPath) : null;

			text =
				theme.fg("toolTitle", theme.bold("write")) +
				" " +
				(path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "..."));

			if (fileContent === null) {
				text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
			} else if (fileContent) {
				const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;

				let lines: string[];
				if (lang) {
					const cache = this.writeHighlightCache;
					if (cache && cache.lang === lang && cache.rawPath === rawPath && cache.rawContent === fileContent) {
						lines = cache.highlightedLines;
					} else {
						const displayContent = normalizeDisplayText(fileContent);
						const normalized = replaceTabs(displayContent);
						lines = highlightCode(normalized, lang);
						this.writeHighlightCache = {
							rawPath,
							lang,
							rawContent: fileContent,
							normalizedLines: normalized.split("\n"),
							highlightedLines: lines,
						};
					}
				} else {
					lines = normalizeDisplayText(fileContent).split("\n");
					this.writeHighlightCache = undefined;
				}

				const totalLines = lines.length;
				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text +=
					"\n\n" +
					displayLines.map((line: string) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n");
				if (remaining > 0) {
					text +=
						theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`) +
						` ${keyHint("expandTools", "to expand")})`;
				}
			}

			// Show error if tool execution failed
			if (this.result?.isError) {
				const errorText = this.getTextOutput();
				if (errorText) {
					text += `\n\n${theme.fg("error", errorText)}`;
				}
			}
		} else if (this.toolName === "edit") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath) : null;

			// Build path display, appending :line if we have diff info
			let pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			const firstChangedLine =
				(this.editDiffPreview && "firstChangedLine" in this.editDiffPreview
					? this.editDiffPreview.firstChangedLine
					: undefined) ||
				(this.result && !this.result.isError ? this.result.details?.firstChangedLine : undefined);
			if (firstChangedLine) {
				pathDisplay += theme.fg("warning", `:${firstChangedLine}`);
			}

			text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

			if (this.result?.isError) {
				// Show error from result
				const errorText = this.getTextOutput();
				if (errorText) {
					text += `\n\n${theme.fg("error", errorText)}`;
				}
			} else if (this.result?.details?.diff) {
				// Tool executed successfully - use the diff from result
				// This takes priority over editDiffPreview which may have a stale error
				// due to race condition (async preview computed after file was modified)
				text += `\n\n${renderDiff(this.result.details.diff, { filePath: rawPath ?? undefined })}`;
			} else if (this.editDiffPreview) {
				// Use cached diff preview (before tool executes)
				if ("error" in this.editDiffPreview) {
					text += `\n\n${theme.fg("error", this.editDiffPreview.error)}`;
				} else if (this.editDiffPreview.diff) {
					text += `\n\n${renderDiff(this.editDiffPreview.diff, { filePath: rawPath ?? undefined })}`;
				}
			}
		} else if (this.toolName === "ls") {
			const rawPath = str(this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const limit = this.args?.limit;

			text = `${theme.fg("toolTitle", theme.bold("ls"))} ${path === null ? invalidArg : theme.fg("accent", path)}`;
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 20;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}

				const entryLimit = this.result.details?.entryLimitReached;
				const truncation = this.result.details?.truncation;
				if (entryLimit || truncation?.truncated) {
					const warnings: string[] = [];
					if (entryLimit) {
						warnings.push(`${entryLimit} entries limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (this.toolName === "find") {
			const pattern = str(this.args?.pattern);
			const rawPath = str(this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const limit = this.args?.limit;

			text =
				theme.fg("toolTitle", theme.bold("find")) +
				" " +
				(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
				theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 20;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}

				const resultLimit = this.result.details?.resultLimitReached;
				const truncation = this.result.details?.truncation;
				if (resultLimit || truncation?.truncated) {
					const warnings: string[] = [];
					if (resultLimit) {
						warnings.push(`${resultLimit} results limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (this.toolName === "grep") {
			const pattern = str(this.args?.pattern);
			const rawPath = str(this.args?.path);
			const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const glob = str(this.args?.glob);
			const limit = this.args?.limit;

			text =
				theme.fg("toolTitle", theme.bold("grep")) +
				" " +
				(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
				theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
			if (glob) {
				text += theme.fg("toolOutput", ` (${glob})`);
			}
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` limit ${limit}`);
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 15;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}

				const matchLimit = this.result.details?.matchLimitReached;
				const truncation = this.result.details?.truncation;
				const linesTruncated = this.result.details?.linesTruncated;
				if (matchLimit || truncation?.truncated || linesTruncated) {
					const warnings: string[] = [];
					if (matchLimit) {
						warnings.push(`${matchLimit} matches limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					if (linesTruncated) {
						warnings.push("some lines truncated");
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (this.toolName === "web_search") {
			// Server-side Anthropic web search
			text = theme.fg("toolTitle", theme.bold("web search"));

			if (process.env.PI_OFFLINE === "1") {
				text += "\n\n" + theme.fg("muted", "\u{1F50C} Offline \u{2014} web search unavailable");
			} else if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 10;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
					}
				}
			}
		} else {
			// Generic tool (shouldn't reach here for custom tools)
			text = theme.fg("toolTitle", theme.bold(this.toolDisplayName));

			if (!this.expanded) {
				const status = this.isPartial
					? theme.fg("muted", "(running...)")
					: this.result?.isError
						? theme.fg("error", "(error)")
						: theme.fg("success", "(done)");
				text += ` ${status} ${theme.fg("muted", "▸")}`;
			} else {
				text += ` ${theme.fg("muted", "▾")}`;
				const content = JSON.stringify(this.args, null, 2);
				text += `\n\n${content}`;
				const output = this.getTextOutput();
				if (output) {
					text += `\n${output}`;
				}
			}
		}

		return this.prependActionPrefix(text);
	}

	private getActionPrefix(): string {
		return `${theme.fg("warning", theme.bold("[tool]"))} `;
	}

	private getBashStatusSuffix(): string {
		if (this.isPartial) return theme.fg("muted", "(running...)");
		const exitCode = this.getBashExitCode();
		if (typeof exitCode === "number") {
			return exitCode === 0 ? theme.fg("success", `(done, ${exitCode})`) : theme.fg("error", `(done, ${exitCode})`);
		}
		return this.result?.isError ? theme.fg("error", "(error)") : theme.fg("success", "(done)");
	}

	private getStatusPlain(): string {
		if (this.isPartial) return "running";
		if (this.result?.isError) return "error";
		if (this.toolName === "bash") {
			const exitCode = this.getBashExitCode();
			if (typeof exitCode === "number") return `done, ${exitCode}`;
		}
		return "done";
	}

	private getBashExitCode(): number | undefined {
		const detailsExitCode = this.result?.details?.exitCode;
		if (typeof detailsExitCode === "number" && Number.isFinite(detailsExitCode)) {
			return detailsExitCode;
		}
		const text = this.getTextOutput();
		const match = text.match(/(?:^|\n)exit_code:\s*(-?\d+)(?:\n|$)/);
		if (!match) return undefined;
		const parsed = Number.parseInt(match[1], 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private getBashOutput(command: string | null): string {
		const raw = this.getTextOutput().trim();
		if (!raw) return "";
		const lines = raw.split("\n");
		if (command && lines[0]?.trim() === `$ ${command}`) {
			lines.shift();
		}
		if (lines[0] && /^exit_code:\s*-?\d+$/.test(lines[0].trim())) {
			lines.shift();
		}
		const meaningfulLines = lines.filter((line) => {
			const trimmed = line.trim();
			if (!trimmed) return false;
			// Generic wrapper/annotation lines are parenthetical metadata, not command output.
			// Example: "(executed by Claude Code)"
			if (/^\([^)]{1,200}\)$/.test(trimmed)) return false;
			return true;
		});
		return meaningfulLines.join("\n").trim();
	}

	private prependActionPrefix(text: string): string {
		const prefix = this.getActionPrefix();
		const firstNewline = text.indexOf("\n");
		if (firstNewline === -1) {
			return prefix + text;
		}
		return prefix + text.slice(0, firstNewline) + text.slice(firstNewline);
	}
}
