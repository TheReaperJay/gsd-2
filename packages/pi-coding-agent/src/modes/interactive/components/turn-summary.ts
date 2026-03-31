import { truncateToWidth, type Component, type TUI, visibleWidth } from "@gsd/pi-tui";
import { theme } from "../theme/theme.js";
import { editorKey } from "./keybinding-hints.js";

export type TurnSummaryStatus = "running" | "done" | "error" | "aborted";

export interface TurnSummaryMetrics {
	startMs: number;
	endMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	thinkingOutputTokens?: number;
	normalOutputTokens?: number;
	toolUses: number;
	linesAdded: number;
	linesRemoved: number;
	status: TurnSummaryStatus;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatDuration(metrics: TurnSummaryMetrics): string {
	const end = metrics.endMs ?? Date.now();
	const durationMs = Math.max(0, end - metrics.startMs);
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function getStatusLabel(status: TurnSummaryStatus): string {
	if (status === "running") return "running...";
	if (status === "done") return "done";
	if (status === "error") return "error";
	return "aborted";
}

function buildSingleLine(metrics: TurnSummaryMetrics): string {
	const inTokens = formatTokens(metrics.inputTokens ?? 0);
	const outTokens = formatTokens(metrics.outputTokens ?? 0);
	const thinkingTokens =
		typeof metrics.thinkingOutputTokens === "number" ? formatTokens(metrics.thinkingOutputTokens) : "?";
	const normalTokens =
		typeof metrics.normalOutputTokens === "number" ? formatTokens(metrics.normalOutputTokens) : outTokens;

	return (
		theme.bold("[summary]") +
		` time ${formatDuration(metrics)} | tok in ${inTokens} out thk:${thinkingTokens} norm:${normalTokens} | tools ${metrics.toolUses} | diff +${metrics.linesAdded}/-${metrics.linesRemoved} | ${getStatusLabel(metrics.status)}`
	);
}

function buildCollapsedLine(metrics: TurnSummaryMetrics): string {
	return (
		theme.bold("[summary]") +
		` time ${formatDuration(metrics)} | tools ${metrics.toolUses} | diff +${metrics.linesAdded}/-${metrics.linesRemoved} (` +
		theme.fg("dim", editorKey("expandTools")) +
		" to expand)"
	);
}

function buildExpandedLines(metrics: TurnSummaryMetrics): string[] {
	const inTokens = formatTokens(metrics.inputTokens ?? 0);
	const outTokens = formatTokens(metrics.outputTokens ?? 0);
	const thinkingTokens =
		typeof metrics.thinkingOutputTokens === "number" ? formatTokens(metrics.thinkingOutputTokens) : "?";
	const normalTokens =
		typeof metrics.normalOutputTokens === "number" ? formatTokens(metrics.normalOutputTokens) : outTokens;

	return [
		theme.bold("[summary]"),
		`time: ${formatDuration(metrics)}`,
		`tokens in: ${inTokens}`,
		`tokens out thinking: ${thinkingTokens}`,
		`tokens out normal: ${normalTokens}`,
		`tool uses: ${metrics.toolUses}`,
		`diff: +${metrics.linesAdded} / -${metrics.linesRemoved}`,
		`status: ${getStatusLabel(metrics.status)}`,
	];
}

export class TurnSummaryComponent implements Component {
	private expanded = false;
	private metrics: TurnSummaryMetrics;
	private ticker?: ReturnType<typeof setInterval>;

	constructor(
		private readonly ui: TUI,
		initialMetrics: TurnSummaryMetrics,
	) {
		this.metrics = initialMetrics;
		this.reconcileTicker();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.ui.requestRender();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	updateMetrics(update: Partial<TurnSummaryMetrics>): void {
		this.metrics = { ...this.metrics, ...update };
		this.reconcileTicker();
		this.ui.requestRender();
	}

	dispose(): void {
		this.stopTicker();
	}

	render(width: number): string[] {
		if (this.expanded) {
			return buildExpandedLines(this.metrics).map((line) => theme.fg("dim", truncateToWidth(line, width, "...")));
		}

		const fullLine = buildSingleLine(this.metrics);
		if (visibleWidth(fullLine) <= width) {
			return [theme.fg("dim", fullLine)];
		}

		return [theme.fg("dim", truncateToWidth(buildCollapsedLine(this.metrics), width, "..."))];
	}

	invalidate(): void {}

	private reconcileTicker(): void {
		if (this.metrics.status === "running") {
			this.startTicker();
		} else {
			this.stopTicker();
		}
	}

	private startTicker(): void {
		if (this.ticker) return;
		this.ticker = setInterval(() => this.ui.requestRender(), 1000);
	}

	private stopTicker(): void {
		if (!this.ticker) return;
		clearInterval(this.ticker);
		this.ticker = undefined;
	}
}
