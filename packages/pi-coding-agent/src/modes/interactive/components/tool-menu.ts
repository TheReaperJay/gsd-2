import { Container, getEditorKeybindings, matchesKey, Spacer, Text, truncateToWidth, type TUI } from "@gsd/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";
import type { ToolExecutionComponent } from "./tool-execution.js";

function clip(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "...");
}

export class ToolMenuComponent extends Container {
	private readonly tools: ToolExecutionComponent[];
	private readonly onClose: () => void;
	private readonly ui: TUI;
	private selectedIndex: number;

	constructor(tools: ToolExecutionComponent[], onClose: () => void, ui: TUI) {
		super();
		this.tools = tools;
		this.onClose = onClose;
		this.ui = ui;
		this.selectedIndex = Math.max(0, tools.length - 1);
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectCancel") || kb.matches(keyData, "expandTools") || matchesKey(keyData, "ctrl+o")) {
			this.onClose();
			this.ui.requestRender();
			return;
		}
		if (this.tools.length === 0) return;
		if (kb.matches(keyData, "selectUp") || keyData === "k") {
			this.selectedIndex = this.selectedIndex === 0 ? this.tools.length - 1 : this.selectedIndex - 1;
			this.ui.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectDown") || keyData === "j") {
			this.selectedIndex = this.selectedIndex === this.tools.length - 1 ? 0 : this.selectedIndex + 1;
			this.ui.requestRender();
			return;
		}
		if (kb.matches(keyData, "selectConfirm") || keyData === "\n" || keyData === "\r") {
			const tool = this.tools[this.selectedIndex];
			if (tool) {
				tool.setExpanded(!tool.isExpanded());
				this.ui.requestRender();
			}
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
			const maxVisible = Math.min(8, this.tools.length);
			const start = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.tools.length - maxVisible),
			);
			const end = Math.min(this.tools.length, start + maxVisible);

			for (let i = start; i < end; i++) {
				const snapshot = this.tools[i]!.getMenuSnapshot();
				const isSelected = i === this.selectedIndex;
				const prefix = isSelected ? "→ " : "  ";
				const marker = snapshot.expanded ? "▾" : "▸";
				const label = `${marker} ${snapshot.label} (${snapshot.status})`;
				const line = clip(prefix + label, contentWidth);
				lines.push(` ${isSelected ? listTheme.selectedText(line) : line}`);
			}

			if (this.tools.length > maxVisible) {
				lines.push(` ${listTheme.scrollInfo(`(${this.selectedIndex + 1}/${this.tools.length})`)}`);
			}

			const selected = this.tools[this.selectedIndex]!;
			const preview = selected.getMenuSnapshot();
			lines.push("");
			lines.push(` ${theme.fg("muted", "┌ output preview")}`);
			if (preview.previewLines.length === 0) {
				lines.push(` ${theme.fg("muted", "│ (no output)")}`);
			} else {
				for (const line of preview.previewLines) {
					lines.push(` ${theme.fg("muted", "│")} ${theme.fg("toolOutput", clip(line, contentWidth - 4))}`);
				}
				if (preview.totalPreviewLines > preview.previewLines.length) {
					const hidden = preview.totalPreviewLines - preview.previewLines.length;
					lines.push(` ${theme.fg("muted", `│ ... (${hidden} more lines)`)}`);
				}
			}
			lines.push(` ${theme.fg("muted", "└")}`);
		}

		lines.push("");
		lines.push(
			` ${rawKeyHint("↑↓", "navigate")}  ${keyHint("selectConfirm", "toggle selected")}  ${keyHint("expandTools", "close")}`,
		);
		lines.push("");
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}
}
