/**
 * Snapshot diffing — compares two text snapshots line-by-line and
 * returns a compact description of the change.  Used by:
 *   • Monitor (frame recording): record only when something changed.
 *   • wait_for_idle + snapshot diffing tools: let the caller see at a
 *     glance what moved between two snapshots.
 */

import type { Snapshot } from './snapshot.js';

export interface LineDiff {
    row: number;
    before: string;
    after: string;
}

export interface SnapshotDiff {
    /** Snapshot was fully identical to the previous one. */
    identical: boolean;
    /** The cursor moved even if no cell changed. */
    cursorMoved: boolean;
    /** Dimensions changed (implies a resize). */
    resized: boolean;
    /** Changed lines — only rows where text differs. */
    changedLines: LineDiff[];
    /** Rows that appeared (previous snapshot had fewer rows). */
    addedRows: number[];
    /** Rows that were removed (previous had more rows). */
    removedRows: number[];
}

/**
 * Diff two snapshots.  Robust to differing dimensions — missing rows on
 * either side are reported in `addedRows` / `removedRows`.
 */
export function diffSnapshots(prev: Snapshot | null, next: Snapshot): SnapshotDiff {
    if (prev === null) {
        // No previous frame — everything is "new".
        return {
            identical: false,
            cursorMoved: true,
            resized: true,
            changedLines: next.lines.map((text, row) => ({
                row,
                before: '',
                after: text,
            })),
            addedRows: next.lines.map((_, i) => i),
            removedRows: [],
        };
    }

    const resized = prev.cols !== next.cols || prev.rows !== next.rows;
    const cursorMoved =
        prev.cursor.row !== next.cursor.row ||
        prev.cursor.col !== next.cursor.col ||
        prev.cursor.visible !== next.cursor.visible;

    const changed: LineDiff[] = [];
    const commonRows = Math.min(prev.lines.length, next.lines.length);
    for (let r = 0; r < commonRows; r += 1) {
        const a = prev.lines[r]!;
        const b = next.lines[r]!;
        if (a !== b) {
            changed.push({ row: r, before: a, after: b });
        }
    }

    const addedRows: number[] = [];
    const removedRows: number[] = [];
    if (next.lines.length > prev.lines.length) {
        for (let r = prev.lines.length; r < next.lines.length; r += 1) {
            addedRows.push(r);
            changed.push({ row: r, before: '', after: next.lines[r]! });
        }
    } else if (prev.lines.length > next.lines.length) {
        for (let r = next.lines.length; r < prev.lines.length; r += 1) {
            removedRows.push(r);
        }
    }

    const identical =
        !resized && !cursorMoved && changed.length === 0 && addedRows.length === 0 && removedRows.length === 0;

    return { identical, cursorMoved, resized, changedLines: changed, addedRows, removedRows };
}
