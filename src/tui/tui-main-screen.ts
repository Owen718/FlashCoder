// Ported from Pi's TUI package.
//   https://github.com/earendil-works/pi @ 05bf9df65155e047e4ba8459eaee9735e29a2e53
//   packages/tui/src/tui-main-screen.ts
// Copyright (c) 2025 Mario Zechner. MIT License.
// Adapted for FlashCoder: .ts import specifiers changed to .js for NodeNext.

import * as fs from "node:fs";
import * as path from "node:path";
import { deleteKittyImage, isImageLine } from "./terminal-image.js";
import { type TUI, TuiBase, type TuiStopOptions } from "./tui.js";
import {
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "./utils.js";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;
	/** True while the screen is showing a history window rather than the newest content. */
	private scrollModeActive = false;
	/** Mouse selection: 0-based line/column into fullContent, or null when inactive. */
	private selectionAnchor: { readonly line: number; readonly col: number } | null = null;
	private selectionHead: { readonly line: number; readonly col: number } | null = null;
	/** The full rendered content, before scroll-window slicing. */
	private fullContent: string[] = [];
	/** The fullContent line currently shown at physical screen row 0. */
	private visibleStart = 0;
	/** The fullContent line at window row 0 while scroll mode is active. */
	private windowStart = 0;

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
	}

	/**
	 * Start a mouse selection at a visible screen position (0-based row and
	 * column). The point is stored in full-content coordinates, so scrolling
	 * while dragging keeps the anchor on the same content.
	 */
	beginSelection(screenRow: number, screenCol: number): boolean {
		const line = this.visibleStart + screenRow;
		if (line < 0 || line >= this.fullContent.length) {
			this.clearSelection();
			return false;
		}
		const point = Object.freeze({
			line,
			col: Math.max(0, screenCol),
		});
		this.selectionAnchor = point;
		this.selectionHead = point;
		this.requestRender();
		return true;
	}

	/** Extend the active selection to a visible screen position. */
	extendSelection(screenRow: number, screenCol: number): void {
		if (this.selectionAnchor === null) return;
		const line = Math.max(
			0,
			Math.min(
				this.visibleStart + screenRow,
				this.fullContent.length - 1,
			),
		);
		this.selectionHead = Object.freeze({
			line,
			col: Math.max(0, screenCol),
		});
		this.requestRender();
	}

	/**
	 * The auto-scroll direction implied by the cursor sitting on an edge row,
	 * or null when auto-scroll should not run. Only scrolls while the drag is
	 * already moving that way: the top edge reveals older content when the
	 * head is above the anchor, and the bottom edge reveals newer content
	 * when the head is below it.
	 */
	selectionAutoScrollDirection(screenRow: number): 1 | -1 | null {
		const anchor = this.selectionAnchor;
		const head = this.selectionHead;
		if (anchor === null || head === null) return null;
		const height = this.terminal.rows;
		const maxScroll = Math.max(0, this.fullContent.length - height);
		if (
			screenRow <= 0 &&
			head.line < anchor.line &&
			this.scrollOffset < maxScroll
		) {
			return 1;
		}
		if (
			screenRow >= height - 1 &&
			head.line > anchor.line &&
			this.scrollOffset > 0
		) {
			return -1;
		}
		return null;
	}

	/**
	 * Auto-scroll one line toward older content (direction 1) or newer
	 * content (-1) and extend the selection to the newly visible edge row.
	 * Returns false when there is no more content to reveal in that direction.
	 *
	 * This does not force a synchronous render: it computes the next window
	 * start directly and leaves the repaint to the batched render timer, so
	 * rapid edge motion reports stay smooth instead of re-rendering per event.
	 */
	scrollSelection(direction: 1 | -1, screenCol: number): boolean {
		if (this.selectionAnchor === null) return false;
		const height = this.terminal.rows;
		const maxScroll = Math.max(0, this.fullContent.length - height);
		const nextOffset = Math.max(
			0,
			Math.min(this.scrollOffset + direction, maxScroll),
		);
		if (nextOffset === this.scrollOffset) return false;
		this.scrollOffset = nextOffset;
		// The window start for the next render, computed here so extendSelection
		// maps the edge row to the correct content line without waiting for a
		// synchronous paint.
		this.visibleStart = Math.max(
			0,
			this.fullContent.length - height - nextOffset,
		);
		const edgeRow = direction === 1 ? 0 : height - 1;
		this.extendSelection(edgeRow, screenCol);
		this.requestRender();
		return true;
	}

	/** Finish the selection, return its plain text (null when empty), and clear it. */
	endSelection(): string | null {
		const text = this.extractSelectionText();
		this.clearSelection();
		return text;
	}

	clearSelection(): void {
		if (this.selectionAnchor === null) return;
		this.selectionAnchor = null;
		this.selectionHead = null;
		this.requestRender();
	}

	hasSelection(): boolean {
		return this.selectionAnchor !== null;
	}

	private orderedSelection(): {
		readonly start: { readonly line: number; readonly col: number };
		readonly end: { readonly line: number; readonly col: number };
	} | null {
		const anchor = this.selectionAnchor;
		const head = this.selectionHead;
		if (anchor === null || head === null) return null;
		if (anchor.line === head.line && anchor.col === head.col) return null;
		const flipped =
			anchor.line > head.line ||
			(anchor.line === head.line && anchor.col > head.col);
		return flipped
			? { start: head, end: anchor }
			: { start: anchor, end: head };
	}

	/** The selected span of one content line, or null when outside the selection. */
	private selectionSpan(
		lineIndex: number,
		selection: { readonly start: { readonly line: number; readonly col: number }; readonly end: { readonly line: number; readonly col: number } },
	): { readonly from: number; readonly to: number } | null {
		if (lineIndex < selection.start.line || lineIndex > selection.end.line) {
			return null;
		}
		return {
			from: lineIndex === selection.start.line ? selection.start.col : 0,
			to: lineIndex === selection.end.line ? selection.end.col : Number.MAX_SAFE_INTEGER,
		};
	}

	/** Apply reverse-video highlight to the selected spans of the visible window. */
	private applySelectionHighlight(lines: string[], firstContentLine: number): string[] {
		const selection = this.orderedSelection();
		if (selection === null) return lines;
		return lines.map((line, index) => {
			const contentLine = firstContentLine + index;
			const span = this.selectionSpan(contentLine, selection);
			if (span === null) return line;
			const width = visibleWidth(line);
			const from = Math.min(span.from, width);
			const to = Math.min(span.to, width);
			if (to <= from) return line;
			const before = sliceByColumn(line, 0, from);
			const selected = stripTerminalSequences(sliceByColumn(line, from, to - from));
			const after = sliceByColumn(line, to, Math.max(0, width - to));
			return `${before}\x1b[0m\x1b[7m${selected}\x1b[27m${after}`;
		});
	}

	/** The selected text, stripped of ANSI codes, or null when empty. */
	private extractSelectionText(): string | null {
		const selection = this.orderedSelection();
		if (selection === null) return null;
		const lines: string[] = [];
		for (
			let lineIndex = selection.start.line;
			lineIndex <= selection.end.line;
			lineIndex += 1
		) {
			const line = this.fullContent[lineIndex] ?? "";
			const span = this.selectionSpan(lineIndex, selection);
			if (span === null) continue;
			const width = visibleWidth(line);
			const from = Math.min(span.from, width);
			const to = Math.min(span.to, width);
			lines.push(
				stripTerminalSequences(
					sliceByColumn(line, from, Math.max(0, to - from)),
				).trimEnd(),
			);
		}
		const text = lines.join("\n");
		return text.trim().length > 0 ? text : null;
	}

	protected override resetRenderState(): void {
		this.previousLines = [];
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		if (options.preserveScreen || this.previousLines.length === 0) return;
		this.terminal.write(" ");
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	protected doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines
		let newLines = this.render(width);

		// Composite overlays into the rendered lines (before differential compare)
		if (this.hasOverlayEntries) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// The full rendered content, before any scroll-window slicing. Mouse
		// selection coordinates live in this space so dragging across a scroll
		// keeps the anchor on the same content.
		this.fullContent = newLines;

		// Helper to clear scrollback and viewport and render all new lines
		// `clearScrollback` is false for the history viewport: entering or
		// leaving it redraws the screen without destroying the terminal's own
		// scrollback, so tmux copy-mode history survives the round trip.
		const fullRender = (clear: boolean, clearScrollback = true): void => {
			this.fullRedrawCount += 1;
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			if (clear) {
				buffer += this.deleteKittyImages(this.previousKittyImageIds);
				buffer += "\x1b[2J\x1b[H"; // Clear screen and home
				if (clearScrollback) {
					buffer += "\x1b[3J"; // Clear scrollback
				}
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				const line = newLines[i];
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						buffer += "\r\n";
					}
					buffer += `\x1b[${imageReservedRows - 1}A`;
					buffer += line;
					buffer += `\x1b[${imageReservedRows - 1}B`;
					i += imageReservedRows - 1;
					continue;
				}
				buffer += line;
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.visibleStart = this.scrollModeActive
				? this.windowStart
				: this.previousViewportTop;
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(this.logDirectory, "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, msg);
		};

		// History viewport: when the user has scrolled back (wheel, PageUp,
		// PageDown, Home, End), show a window into the rendered content
		// instead of its tail. `scrollOffset` counts rows back from the newest
		// content, so the window is `content[len - height - offset, len - offset)`.
		// Entering and leaving the window redraws the screen without clearing
		// the terminal scrollback, so tmux and native terminal history survive
		// the round trip. While inside the window the differential renderer
		// keeps working on the window's rows; leaving it records the window in
		// previousLines, so the next content change redraws once from row 0
		// and then continues seamlessly.
		const maxScrollOffset = Math.max(0, newLines.length - height);
		const targetOffset = Math.min(this.scrollOffset, maxScrollOffset);
		const enteringScroll = targetOffset > 0 && !this.scrollModeActive;
		const leavingScroll = targetOffset === 0 && this.scrollModeActive;
		if (enteringScroll || leavingScroll) {
			this.scrollModeActive = enteringScroll;
			this.scrollOffset = targetOffset;
			const start = newLines.length - height - targetOffset;
			this.windowStart = start;
			this.visibleStart = start;
			let windowLines = newLines.slice(start, start + height);
			while (windowLines.length < height) windowLines.push("");
			if (this.selectionAnchor !== null) {
				windowLines = this.applySelectionHighlight(windowLines, start);
			}
			newLines = windowLines;
			fullRender(true, false);
			return;
		}
		// The fullContent line shown at physical screen row 0, for mapping
		// mouse rows. In scroll mode the window is an explicit slice; otherwise
		// the viewport top names it.
		let firstContentLine = prevViewportTop;
		// The content line that newLines[0] corresponds to, for applying the
		// highlight. After the scroll slice below, newLines[0] is the window's
		// first line; before it, newLines[0] is full content line 0.
		let highlightStart = 0;
		if (this.scrollModeActive) {
			this.scrollOffset = targetOffset;
			const start = newLines.length - height - targetOffset;
			this.windowStart = start;
			firstContentLine = start;
			highlightStart = start;
			newLines = newLines.slice(start, start + height);
			while (newLines.length < height) newLines.push("");
		}
		this.visibleStart = firstContentLine;

		// Mouse selection highlight is applied to the visible window before any
		// render path, so first render, full redraw and differential updates all
		// show it. The highlighted lines are also what previousLines records, so
		// moving or clearing the selection re-renders exactly the changed rows.
		if (this.selectionAnchor !== null) {
			newLines = this.applySelectionHighlight(newLines, highlightStart);
		}

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.visibleStart = this.scrollModeActive ? this.windowStart : prevViewportTop;
			this.previousHeight = height;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					buffer += `\x1b[${clearStartOffset}B`;
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					buffer += `\x1b[${moveBack}A`;
				}
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			this.visibleStart = this.scrollModeActive ? this.windowStart : prevViewportTop;
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			fullRender(true);
			return;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			const line = newLines[i];
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					fullRender(true);
					return;
				}

				buffer += "\x1b[2K";
				for (let row = 1; row < imageReservedRows; row++) {
					buffer += "\r\n\x1b[2K";
				}
				buffer += `\x1b[${imageReservedRows - 1}A`;
				buffer += line;
				buffer += `\x1b[${imageReservedRows - 1}B`;
				i += imageReservedRows - 1;
				continue;
			}

			buffer += "\x1b[2K"; // Clear current line
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(this.logDirectory, "pi-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			buffer += line;
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);
		this.visibleStart = this.scrollModeActive
			? this.windowStart
			: this.previousViewportTop;

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.getShowHardwareCursor()) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
