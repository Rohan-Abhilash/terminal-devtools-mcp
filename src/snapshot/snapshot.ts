/**
 * Snapshot — reads the current screen state out of an @xterm/headless
 * emulator and turns it into formats useful to an MCP caller:
 *
 *   • `text`   — plain visible characters, one line per row, trimmed.
 *   • `ansi`   — same but with ANSI SGR runs reconstructed so colours /
 *                styles round-trip when the caller re-prints the output.
 *   • `cells`  — a 2-D array of cell records { char, fg, bg, bold, … }
 *                for callers that want structured data.
 *   • `cursor` — row/col/visible struct.
 *
 * The `Snapshot` object itself bundles metadata (dimensions, cursor,
 * timestamp) so a single tool call returns everything the agent needs.
 */

import type { Terminal as XtermTerminal } from '@xterm/headless';

export interface SnapshotCursor {
    row: number;      // 0-based
    col: number;      // 0-based
    visible: boolean; // cursor blinking state irrelevant — we report the
                      // logical "is the cursor showing" flag
}

export interface SnapshotCell {
    /**
     * The character at this cell — can be multi-codepoint for wide chars
     * (e.g. emoji that occupy two columns are reported as one cell with
     * `width: 2`).  Empty string for a cleared cell.
     */
    char: string;
    /** Cell width in columns (1 or 2). */
    width: 1 | 2;
    /** Foreground color — null for default, or { palette: n } / { rgb: #RRGGBB }. */
    fg: CellColor | null;
    /** Background color. */
    bg: CellColor | null;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    inverse: boolean;
    dim: boolean;
    strike: boolean;
    invisible: boolean;
}

export type CellColor =
    | { kind: 'palette'; index: number }       // 0..255 ANSI palette
    | { kind: 'rgb'; r: number; g: number; b: number };

/**
 * Scrollback bundle — the terminal's full buffer (the rows above the
 * current viewport plus the visible rows themselves).  Only populated
 * when the caller passes `includeScrollback: true` to `buildSnapshot`.
 *
 * Useful when a long-running command has pushed content out of the
 * visible area, or when a normal-buffer shell session has accumulated
 * many screens worth of logs and the caller wants the complete
 * history, not just the slice currently on screen.
 */
export interface SnapshotScrollback {
    /** Total lines in the active buffer (scrollback + visible). */
    totalLines: number;
    /** Inclusive index of the first visible line in the buffer. */
    viewportStartLine: number;
    /** Inclusive index of the last visible line in the buffer. */
    viewportEndLine: number;
    /**
     * Every line from index 0 through `totalLines - 1`, in order.
     * Length may be less than `totalLines` if the output was truncated
     * to `maxLines` (see `truncated`).
     */
    lines: string[];
    /** Same as `lines.join('\n')` — convenient single-string form. */
    text: string;
    /** True when the active buffer is the alternate screen (a full-screen
     *  TUI such as `vim` / `htop` / most Ink apps). Alt-screen buffers
     *  don't carry scrollback — the pre-existing shell history is on the
     *  normal buffer.  In that case the caller can still see the hidden
     *  pre-TUI history through `normalBuffer`. */
    isAltScreen: boolean;
    /**
     * When `isAltScreen` is true, this holds the normal buffer — the
     * scrollback the shell accumulated before the TUI took over.  When
     * the active buffer IS the normal buffer, this field is omitted.
     */
    normalBuffer?: {
        totalLines: number;
        lines: string[];
        text: string;
    };
    /** True when the full buffer exceeded `maxLines` and the result was
     *  clipped to the tail (most recent lines kept). */
    truncated: boolean;
    /** The cap that was applied — echoed back for transparency. */
    maxLines: number;
}

export interface Snapshot {
    /** When the snapshot was taken (unix ms). */
    takenAt: number;
    cols: number;
    rows: number;
    cursor: SnapshotCursor;
    /** Array of length `rows`; each entry is one line of plain text.
     *  These are the CURRENTLY VISIBLE rows — equivalent to what a human
     *  looking at the terminal right now would see. */
    lines: string[];
    /** Same lines concatenated with "\n". */
    text: string;
    /** Optional — populated only when `format` requests it. */
    ansi?: string;
    /** Optional — populated only when `format` requests it. */
    cells?: SnapshotCell[][];
    /** Optional — populated only when `includeScrollback` was true. */
    scrollback?: SnapshotScrollback;
}

export type SnapshotFormat = 'text' | 'ansi' | 'cells' | 'all';

export interface BuildSnapshotOptions {
    /**
     * When true, also read the full buffer (scrollback + viewport) and
     * attach it as the `scrollback` field.  Default false — the caller
     * pays for this only when they want it.
     */
    includeScrollback?: boolean;
    /**
     * Safety cap on the number of lines returned in `scrollback.lines`
     * (and `scrollback.normalBuffer.lines` when applicable).  If the
     * buffer exceeds this, the most recent `maxScrollbackLines` lines
     * are kept and `scrollback.truncated` is set to true.  Defaults to
     * 10 000 — comfortably above most scrollback limits but bounded.
     */
    maxScrollbackLines?: number;
}

const DEFAULT_MAX_SCROLLBACK_LINES = 10_000;

/**
 * Build a snapshot from an @xterm/headless terminal.  The caller is
 * expected to have awaited the parser flush first (see
 * `TerminalSession.whenParserFlushed()`) so the buffer actually
 * reflects everything written.
 */
export function buildSnapshot(
    terminal: XtermTerminal,
    format: SnapshotFormat = 'text',
    options: BuildSnapshotOptions = {},
): Snapshot {
    const cols = terminal.cols;
    const rows = terminal.rows;
    const buffer = terminal.buffer.active;
    const viewportStart = Math.max(0, buffer.baseY ?? 0);

    const lines: string[] = new Array(rows);
    for (let r = 0; r < rows; r += 1) {
        const line = buffer.getLine(viewportStart + r);
        // `translateToString(true)` drops trailing whitespace per line —
        // matches what a human sees on screen.
        lines[r] = line ? line.translateToString(true) : '';
    }

    const cursor: SnapshotCursor = {
        row: buffer.cursorY,
        col: buffer.cursorX,
        visible: getCursorVisibility(terminal),
    };

    const snap: Snapshot = {
        takenAt: Date.now(),
        cols,
        rows,
        cursor,
        lines,
        text: lines.join('\n'),
    };

    if (format === 'ansi' || format === 'all') {
        snap.ansi = renderAnsi(terminal);
    }
    if (format === 'cells' || format === 'all') {
        snap.cells = readCells(terminal);
    }
    if (options.includeScrollback) {
        snap.scrollback = buildScrollback(terminal, options);
    }
    return snap;
}

/**
 * Read the full active buffer (plus the normal buffer when the active
 * one is the alt-screen) and package it as `SnapshotScrollback`.
 * Applies the `maxScrollbackLines` cap — when exceeded, the tail is
 * preserved (most recent content is the most valuable).
 */
function buildScrollback(
    terminal: XtermTerminal,
    options: BuildSnapshotOptions,
): SnapshotScrollback {
    const maxLines = Math.max(1, options.maxScrollbackLines ?? DEFAULT_MAX_SCROLLBACK_LINES);
    const rows = terminal.rows;
    const active = terminal.buffer.active;
    const isAltScreen = terminal.buffer.active === terminal.buffer.alternate;
    const totalLines = active.length;
    const viewportStart = Math.max(0, active.baseY ?? 0);
    const viewportEnd = Math.min(totalLines - 1, viewportStart + rows - 1);

    const { lines, truncated } = readBufferLines(active, totalLines, maxLines);

    const result: SnapshotScrollback = {
        totalLines,
        viewportStartLine: viewportStart,
        viewportEndLine: viewportEnd,
        lines,
        text: lines.join('\n'),
        isAltScreen,
        truncated,
        maxLines,
    };

    if (isAltScreen) {
        const normal = terminal.buffer.normal;
        const normalTotal = normal.length;
        const { lines: normalLines, truncated: normalTruncated } =
            readBufferLines(normal, normalTotal, maxLines);
        result.normalBuffer = {
            totalLines: normalTotal,
            lines: normalLines,
            text: normalLines.join('\n'),
        };
        if (normalTruncated) result.truncated = true;
    }

    return result;
}

/** Read `count` lines from a buffer, keeping the tail when `count > maxLines`. */
function readBufferLines(
    buffer: import('@xterm/headless').IBuffer,
    count: number,
    maxLines: number,
): { lines: string[]; truncated: boolean } {
    const truncated = count > maxLines;
    const startIdx = truncated ? count - maxLines : 0;
    const keep = truncated ? maxLines : count;
    const lines: string[] = new Array(keep);
    for (let i = 0; i < keep; i += 1) {
        const line = buffer.getLine(startIdx + i);
        lines[i] = line ? line.translateToString(true) : '';
    }
    return { lines, truncated };
}

/**
 * Render the visible buffer as an ANSI-annotated string.  We walk each
 * cell, emit SGR parameter changes only when the style differs from the
 * previous cell, and end each line with "\x1b[0m\n" so re-printing the
 * result is clean.  This reproduces colour, bold, underline, etc. —
 * faithful to what the terminal emitter originally sent.
 */
function renderAnsi(terminal: XtermTerminal): string {
    const rows = terminal.rows;
    const cols = terminal.cols;
    const buffer = terminal.buffer.active;
    const parts: string[] = [];

    for (let r = 0; r < rows; r += 1) {
        const line = buffer.getLine(r);
        if (!line) {
            parts.push('\x1b[0m');
            if (r < rows - 1) parts.push('\n');
            continue;
        }
        let prevStyle = '';
        for (let c = 0; c < cols; c += 1) {
            const cell = line.getCell(c);
            if (!cell) continue;
            if (cell.getWidth() === 0) continue; // skip wide-char trail cells
            const style = sgrForCell(cell);
            if (style !== prevStyle) {
                parts.push('\x1b[0m' + style);
                prevStyle = style;
            }
            const ch = cell.getChars() || ' ';
            parts.push(ch);
        }
        parts.push('\x1b[0m');
        if (r < rows - 1) parts.push('\n');
    }
    return parts.join('');
}

/**
 * Build an SGR escape prefix for a cell's style.  Returns "" for default
 * style.  Palette colours are emitted in the shortest form that works
 * (30-37 / 40-47 for 0..7, 90-97 / 100-107 for 8..15, 38;5;n / 48;5;n
 * for 16..255, 38;2;r;g;b / 48;2;r;g;b for truecolour).
 */
function sgrForCell(cell: import('@xterm/headless').IBufferCell): string {
    const params: number[] = [];
    if (cell.isBold()) params.push(1);
    if (cell.isDim()) params.push(2);
    if (cell.isItalic()) params.push(3);
    if (cell.isUnderline()) params.push(4);
    if (cell.isInverse()) params.push(7);
    if (cell.isInvisible()) params.push(8);
    if (cell.isStrikethrough()) params.push(9);

    if (cell.isFgDefault()) {
        // nothing
    } else if (cell.isFgRGB()) {
        const fg = cell.getFgColor();
        params.push(38, 2, (fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff);
    } else if (cell.isFgPalette()) {
        const idx = cell.getFgColor();
        if (idx < 8) params.push(30 + idx);
        else if (idx < 16) params.push(90 + (idx - 8));
        else params.push(38, 5, idx);
    }

    if (cell.isBgDefault()) {
        // nothing
    } else if (cell.isBgRGB()) {
        const bg = cell.getBgColor();
        params.push(48, 2, (bg >> 16) & 0xff, (bg >> 8) & 0xff, bg & 0xff);
    } else if (cell.isBgPalette()) {
        const idx = cell.getBgColor();
        if (idx < 8) params.push(40 + idx);
        else if (idx < 16) params.push(100 + (idx - 8));
        else params.push(48, 5, idx);
    }

    if (params.length === 0) return '';
    return '\x1b[' + params.join(';') + 'm';
}

/** Read the full cell grid as structured records. */
function readCells(terminal: XtermTerminal): SnapshotCell[][] {
    const rows = terminal.rows;
    const cols = terminal.cols;
    const buffer = terminal.buffer.active;
    const grid: SnapshotCell[][] = new Array(rows);
    for (let r = 0; r < rows; r += 1) {
        const rowCells: SnapshotCell[] = new Array(cols);
        const line = buffer.getLine(r);
        for (let c = 0; c < cols; c += 1) {
            if (!line) {
                rowCells[c] = emptyCell();
                continue;
            }
            const cell = line.getCell(c);
            if (!cell) {
                rowCells[c] = emptyCell();
                continue;
            }
            const width = cell.getWidth();
            rowCells[c] = {
                char: cell.getChars() || '',
                width: (width === 2 ? 2 : 1),
                fg: extractColor(cell, 'fg'),
                bg: extractColor(cell, 'bg'),
                bold: cell.isBold() !== 0,
                italic: cell.isItalic() !== 0,
                underline: cell.isUnderline() !== 0,
                inverse: cell.isInverse() !== 0,
                dim: cell.isDim() !== 0,
                strike: cell.isStrikethrough() !== 0,
                invisible: cell.isInvisible() !== 0,
            };
        }
        grid[r] = rowCells;
    }
    return grid;
}

function emptyCell(): SnapshotCell {
    return {
        char: '', width: 1, fg: null, bg: null,
        bold: false, italic: false, underline: false,
        inverse: false, dim: false, strike: false, invisible: false,
    };
}

function extractColor(
    cell: import('@xterm/headless').IBufferCell,
    channel: 'fg' | 'bg',
): CellColor | null {
    if (channel === 'fg') {
        if (cell.isFgDefault()) return null;
        if (cell.isFgRGB()) {
            const v = cell.getFgColor();
            return { kind: 'rgb', r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
        }
        if (cell.isFgPalette()) return { kind: 'palette', index: cell.getFgColor() };
        return null;
    }
    if (cell.isBgDefault()) return null;
    if (cell.isBgRGB()) {
        const v = cell.getBgColor();
        return { kind: 'rgb', r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
    }
    if (cell.isBgPalette()) return { kind: 'palette', index: cell.getBgColor() };
    return null;
}

/**
 * @xterm/headless doesn't directly expose the DECSCUSR cursor-visibility
 * bit on the public API; it does set the `cursorBlink` option on show
 * and unset it on hide via CSI ?25 h/l.  We read through a small helper
 * that tries the documented getter first and falls back gracefully.
 */
function getCursorVisibility(terminal: XtermTerminal): boolean {
    try {
        const opts = terminal.options as unknown as { cursorBlink?: boolean };
        if (opts && typeof opts.cursorBlink === 'boolean') return opts.cursorBlink;
    } catch { /* ignore */ }
    // Conservative default: assume cursor is visible unless we know otherwise.
    return true;
}
