import { describe, expect, it } from '@jest/globals';
import { diffSnapshots } from '../../src/snapshot/diff.js';
import type { Snapshot } from '../../src/snapshot/snapshot.js';

function mkSnap(overrides: Partial<Snapshot>): Snapshot {
    return {
        takenAt: 0,
        cols: 5,
        rows: 3,
        cursor: { row: 0, col: 0, visible: true },
        lines: ['', '', ''],
        text: '\n\n',
        ...overrides,
    };
}

describe('diffSnapshots', () => {
    it('reports everything as new when prev is null', () => {
        const next = mkSnap({ lines: ['a', 'b', 'c'] });
        const d = diffSnapshots(null, next);
        expect(d.identical).toBe(false);
        expect(d.addedRows).toEqual([0, 1, 2]);
        expect(d.changedLines).toHaveLength(3);
    });

    it('returns identical when both snapshots match exactly', () => {
        const a = mkSnap({ lines: ['x', 'y', 'z'] });
        const b = mkSnap({ lines: ['x', 'y', 'z'] });
        const d = diffSnapshots(a, b);
        expect(d.identical).toBe(true);
        expect(d.cursorMoved).toBe(false);
        expect(d.resized).toBe(false);
        expect(d.changedLines).toHaveLength(0);
    });

    it('reports per-row changes', () => {
        const a = mkSnap({ lines: ['a', 'b', 'c'] });
        const b = mkSnap({ lines: ['a', 'B', 'c'] });
        const d = diffSnapshots(a, b);
        expect(d.identical).toBe(false);
        expect(d.changedLines).toEqual([{ row: 1, before: 'b', after: 'B' }]);
    });

    it('reports cursor movement separately from content changes', () => {
        const a = mkSnap({ lines: ['x', 'y', 'z'] });
        const b = mkSnap({ lines: ['x', 'y', 'z'], cursor: { row: 1, col: 0, visible: true } });
        const d = diffSnapshots(a, b);
        expect(d.identical).toBe(false);
        expect(d.cursorMoved).toBe(true);
        expect(d.changedLines).toHaveLength(0);
    });

    it('reports resized + added rows when the grid grew', () => {
        const a = mkSnap({ rows: 2, lines: ['a', 'b'] });
        const b = mkSnap({ rows: 3, lines: ['a', 'b', 'c'] });
        const d = diffSnapshots(a, b);
        expect(d.resized).toBe(true);
        expect(d.addedRows).toEqual([2]);
        expect(d.changedLines).toEqual([{ row: 2, before: '', after: 'c' }]);
    });

    it('reports removed rows when the grid shrank', () => {
        const a = mkSnap({ rows: 3, lines: ['a', 'b', 'c'] });
        const b = mkSnap({ rows: 2, lines: ['a', 'b'] });
        const d = diffSnapshots(a, b);
        expect(d.resized).toBe(true);
        expect(d.removedRows).toEqual([2]);
    });
});
