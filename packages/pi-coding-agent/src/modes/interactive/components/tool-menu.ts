import { Container, getEditorKeybindings, matchesKey, Spacer, Text, truncateToWidth, type TUI } from "@gsd/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";
import type { ToolExecutionComponent } from "./tool-execution.js";

function clip(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "...");
}

function parseMouseWheelDelta(keyData: string): -1 | 0 | 1 {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(keyData);
	if (!match) return 0;
	const button = Number.parseInt(match[1]!, 10);
	if (!Number.isFinite(button)) return 0;
	if ((button & 0x40) === 0) return 0;
	return (button & 0x01) === 0x01 ? 1 : -1;
}

function computeScrollbar(
	totalLines: number,
	visibleLines: number,
	offset: number,
): { thumbStart: number; thumbSize: number } | null {
	if (visibleLines <= 0 || totalLines <= visibleLines) return null;
	const thumbSize = Math.max(1, Math.floor((visibleLines / totalLines) * visibleLines));
	const maxOffset = Math.max(1, totalLines - visibleLines);
	const maxThumbStart = Math.max(0, visibleLines - thumbSize);
	const thumbStart = Math.min(maxThumbStart, Math.floor((offset / maxOffset) * maxThumbStart));
	return { thumbStart, thumbSize };
}

export class ToolMenuComponent extends Container {
	private readonly tools: ToolExecutionComponent[];
	private readonly onClose: () => void;
	private readonly ui: TUI;
	private selectedIndex: number;
	private mode: "list" | "inspect" = "list";
	private readonly outputOffsets = new Map<number, number>();

	constructor(tools: ToolExecutionComponent[], onClose: () => void, ui: TUI) {
		super();
		this.tools = tools;
		this.onClose = onClose;
		this.ui = ui;
		this.selectedIndex = Math.max(0, tools.length - 1);
	}

	private getVisibleOutputRows(): number {
		const termRows = Math.max(12, this.ui.terminal.rows);
		return Math.max(6, Math.min(18, Math.floor(termRows * 0.35)));
	}

	private getSelectedOutputLines(): string[] {
		const selected = this.tools[this.selectedIndex];
		return selected ? selected.getInspectorOutputLines() : [];
	}

	private getCurrentOutputOffset(): number {
		return this.outputOffsets.get(this.selectedIndex) ?? 0;
	}

	private setCurrentOutputOffset(nextOffset: number): void {
		const lines = this.getSelectedOutputLines();
		const maxOffset = Math.max(0, lines.length - this.getVisibleOutputRows());
		const clamped = Math.max(0, Math.min(nextOffset, maxOffset));
		this.outputOffsets.set(this.selectedIndex, clamped);
	}

	private moveSelection(delta: number): void {
		if (this.tools.length === 0) return;
		const next = (this.selectedIndex + delta + this.tools.length) % this.tools.length;
		this.selectedIndex = next;
		this.setCurrentOutputOffset(this.getCurrentOutputOffset());
	}

	private scrollOutput(delta: number): void {
		this.setCurrentOutputOffset(this.getCurrentOutputOffset() + delta);
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "expandTools") || matchesKey(keyData, "ctrl+o")) {
			this.onClose();
			this.ui.requestRender();
			return;
		}

		if (kb.matches(keyData, "selectCancel")) {
			if (this.mode === "inspect") {
				this.mode = "list";
				this.ui.requestRender();
				return;
			}
			this.onClose();
			this.ui.requestRender();
			return;
		}

		if (this.tools.length === 0) return;

		const wheelDelta = parseMouseWheelDelta(keyData);
		if (wheelDelta !== 0) {
			if (this.mode === "inspect") {
				this.scrollOutput(wheelDelta * 3);
			} else {
				this.moveSelection(wheelDelta);
			}
			this.ui.requestRender();
			return;
		}

		if (this.mode === "list") {
			if (kb.matches(keyData, "selectUp") || keyData === "k") {
				this.moveSelection(-1);
				this.ui.requestRender();
				return;
			}
			if (kb.matches(keyData, "selectDown") || keyData === "j") {
				this.moveSelection(1);
				this.ui.requestRender();
				return;
			}
			if (kb.matches(keyData, "selectPageUp")) {
				this.moveSelection(-6);
				this.ui.requestRender();
				return;
			}
			if (kb.matches(keyData, "selectPageDown")) {
				this.moveSelection(6);
				this.ui.requestRender();
				return;
			}
			if (kb.matches(keyData, "selectConfirm") || keyData === "\n" || keyData === "\r") {
				this.mode = "inspect";
				this.setCurrentOutputOffset(this.getCurrentOutputOffset());
				this.ui.requestRender();
				return;
			}
			return;
		}

		if (kb.matches(keyData, "selectUp") || keyData === "k") {
			this.scrollOutput(-1);
			this.ui.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectDown") || keyData === "j") {
			this.scrollOutput(1);
			this.ui.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageUp")) {
			this.scrollOutput(-this.getVisibleOutputRows());
			this.ui.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectPageDown")) {
			this.scrollOutput(this.getVisibleOutputRows());
			this.ui.requestRender();
			return;
		}
		if (matchesKey(keyData, "home")) {
			this.setCurrentOutputOffset(0);
			this.ui.requestRender();
			return;
		}
		if (matchesKey(keyData, "end")) {
			this.setCurrentOutputOffset(Number.MAX_SAFE_INTEGER);
			this.ui.requestRender();
			return;
		}
	}

	override render(width: number): string[] {
		const lines: string[] = [];
		const listTheme = getSelectListTheme();
		const contentWidth = Math.max(1, width - 4);

		lines.push(...new DynamicBorder().render(width));
		lines.push("");
		lines.push(` ${theme.fg("accent", theme.bold("Tool Menu"))}`);
		lines.push("");

		if (this.tools.length === 0) {
			lines.push(` ${theme.fg("muted", "No tools in current turn history.")}`);
		} else {
			const maxVisible = Math.min(10, this.tools.length);
			const start = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.tools.length - maxVisible),
			);
			const end = Math.min(this.tools.length, start + maxVisible);

			for (let i = start; i < end; i++) {
				const snapshot = this.tools[i]!.getMenuSnapshot();
				const isSelected = i === this.selectedIndex;
				const prefix = isSelected ? "→ " : "  ";
				const label = `${snapshot.label} (${snapshot.status})`;
				const line = clip(prefix + label, contentWidth);
				lines.push(` ${isSelected ? listTheme.selectedText(line) : line}`);
			}

			if (this.tools.length > maxVisible) {
				lines.push(` ${listTheme.scrollInfo(`(${this.selectedIndex + 1}/${this.tools.length})`)}`);
			}

			const selected = this.tools[this.selectedIndex]!;
			const preview = selected.getMenuSnapshot();
			const outputLines = this.getSelectedOutputLines();
			const outputRows = this.getVisibleOutputRows();
			const offset = this.getCurrentOutputOffset();
			const endLine = Math.min(outputLines.length, offset + outputRows);
			const scrollbar = computeScrollbar(outputLines.length, outputRows, offset);
			lines.push("");
			lines.push(
				` ${theme.fg("muted", this.mode === "inspect" ? "┌ output inspector" : "┌ output preview")} ${theme.fg("accent", preview.label)} ${theme.fg("muted", `(${preview.status})`)}`,
			);
			if (this.mode === "list") {
				if (preview.previewLines.length === 0) {
					lines.push(` ${theme.fg("muted", "│ (no output)")}`);
				} else {
					for (const line of preview.previewLines.slice(0, 6)) {
						lines.push(` ${theme.fg("muted", "│")} ${theme.fg("toolOutput", clip(line, contentWidth - 4))}`);
					}
					if (preview.totalPreviewLines > 6) {
						const hidden = preview.totalPreviewLines - 6;
						lines.push(` ${theme.fg("muted", `│ ... (${hidden} more lines)`)}`);
					}
				}
			} else if (outputLines.length === 0) {
				lines.push(` ${theme.fg("muted", "│ (no output)")}`);
			} else {
				const textWidth = Math.max(8, contentWidth - 7);
				for (let row = 0; row < outputRows; row++) {
					const lineIndex = offset + row;
					const rawLine = lineIndex < outputLines.length ? outputLines[lineIndex]! : "";
					const content = clip(rawLine, textWidth).padEnd(textWidth, " ");
					const isThumb = scrollbar
						? row >= scrollbar.thumbStart && row < scrollbar.thumbStart + scrollbar.thumbSize
						: false;
					const barChar = scrollbar
						? (isThumb ? theme.fg("accent", "█") : theme.fg("muted", "│"))
						: theme.fg("muted", " ");
					lines.push(` ${theme.fg("muted", "│")} ${theme.fg("toolOutput", content)} ${barChar}`);
				}
				lines.push(
					` ${theme.fg("muted", `│ lines ${offset + 1}-${Math.max(offset + 1, endLine)} / ${outputLines.length}`)}`,
				);
			}
			lines.push(` ${theme.fg("muted", "└")}`);
		}

		lines.push("");
		if (this.mode === "inspect") {
			lines.push(
				` ${theme.fg("muted", "↑↓/pgup/pgdn scroll")}  ${theme.fg("muted", "wheel scroll")}  ${theme.fg("muted", "esc back")}  ${keyHint("expandTools", "close")}`,
			);
		} else {
			lines.push(
				` ${theme.fg("muted", "↑↓ navigate")}  ${theme.fg("muted", "enter inspect output")}  ${theme.fg("muted", "wheel navigate")}  ${keyHint("expandTools", "close")}`,
			);
		}
		lines.push("");
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}
}
