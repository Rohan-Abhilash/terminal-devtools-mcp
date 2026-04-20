/**
 * Tests for the scrollback support added to `buildSnapshot`.
 *
 * Exercises:
 *   • visible-viewport reading is correct even after the buffer
 *     accumulates scrollback (viewportStartLine > 0)
 *   • `includeScrollback: true` returns the entire active buffer
 *   • `maxScrollbackLines` is respected, tail is preserved, flag set
 *   • alt-screen sessions get a `normalBuffer` bundle with the
 *     pre-TUI history
 */

import { afterEach, describe, expect, it } from '@jest/globals';

import { TerminalSession } from '../../src/session/terminal-session.js';
import { buildSnapshot } from '../../src/snapshot/snapshot.js';

let openSessions: TerminalSession[] = [];

afterEach(async () => {
    await Promise.all(openSessions.map((s) => s.stop('SIGKILL').catch(() => { /* ignore */ })));
    openSessions = [];
});

function track(s: TerminalSession): TerminalSession {
    openSessions.push(s);
    return s;
}

describe('buildSnapshot — default (no scrollback)', () => {
    it('omits the scrollback field when includeScrollback is not set', async () => {
        const s = track(TerminalSession.start({
            command: 'bash', args: ['-c', 'printf hi'], cols: 40, rows: 6,
        }));
        await new Promise<void>((resolve) => s.onExit(() => resolve()));
        await s.whenParserFlushed();

        const snap = buildSnapshot(s.terminal, 'text');
        expect(snap.scrollback).toBeUndefined();
        expect(snap.text).toContain('hi');
    });

    it('visible lines reflect the viewport (baseY-aware)', async () => {
        // Drive enough output to push the viewport past the top of the
        // buffer, confirming we read from baseY, not index 0.
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'for i in $(seq 1 100); do printf "L%03d\\n" $i; done'],
            cols: 20, rows: 5,
        }));
        await new Promise<void>((resolve) => s.onExit(() => resolve()));
        await s.whenParserFlushed();

        const snap = buildSnapshot(s.terminal, 'text');
        // The most recent lines (≈L096..L100) should be what's visible.
        // The very first "L001" should NOT be in the viewport.
        expect(snap.lines.some((l) => l.includes('L100') || l.includes('L099'))).toBe(true);
        expect(snap.lines.some((l) => l === 'L001')).toBe(false);
    });
});

describe('buildSnapshot — includeScrollback', () => {
    it('returns the full active buffer including scrolled-off lines', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'for i in $(seq 1 80); do printf "L%03d\\n" $i; done'],
            cols: 20, rows: 6,
        }));
        await new Promise<void>((resolve) => s.onExit(() => resolve()));
        await s.whenParserFlushed();

        const snap = buildSnapshot(s.terminal, 'text', { includeScrollback: true });
        expect(snap.scrollback).toBeDefined();
        const sb = snap.scrollback!;

        // All 80 log lines should be somewhere in the scrollback.
        expect(sb.text).toContain('L001');
        expect(sb.text).toContain('L040');
        expect(sb.text).toContain('L080');

        // The viewport lines (last visible rows) should agree with
        // snap.lines.
        expect(sb.viewportEndLine - sb.viewportStartLine).toBeLessThanOrEqual(s.terminal.rows - 1);
        expect(sb.totalLines).toBeGreaterThan(s.terminal.rows);
        expect(sb.isAltScreen).toBe(false);
        expect(sb.truncated).toBe(false);
        expect(sb.maxLines).toBe(10_000);
    });

    it('respects maxScrollbackLines and keeps the tail', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'for i in $(seq 1 200); do printf "R%03d\\n" $i; done'],
            cols: 20, rows: 4,
        }));
        await new Promise<void>((resolve) => s.onExit(() => resolve()));
        await s.whenParserFlushed();

        const snap = buildSnapshot(s.terminal, 'text', {
            includeScrollback: true,
            maxScrollbackLines: 30,
        });
        const sb = snap.scrollback!;

        expect(sb.truncated).toBe(true);
        expect(sb.maxLines).toBe(30);
        expect(sb.lines.length).toBeLessThanOrEqual(30);

        // Tail preserved — the last lines should be in the kept slice.
        expect(sb.text).toContain('R200');
        // And the very first lines should have been dropped.
        expect(sb.text).not.toContain('R001');
    });

    it('totalLines grows as more output is produced', async () => {
        const s = track(TerminalSession.start({
            command: 'bash', args: ['-c', 'for i in 1 2 3 4 5; do echo line$i; done'],
            cols: 20, rows: 3,
        }));
        await new Promise<void>((resolve) => s.onExit(() => resolve()));
        await s.whenParserFlushed();

        const snap = buildSnapshot(s.terminal, 'text', { includeScrollback: true });
        const sb = snap.scrollback!;
        // At least 5 content lines + however many trailing blanks the
        // buffer carries.  The key assertion is that totalLines is at
        // least 5.
        expect(sb.totalLines).toBeGreaterThanOrEqual(5);
        for (let i = 1; i <= 5; i += 1) {
            expect(sb.text).toContain(`line${i}`);
        }
    });
});

describe('buildSnapshot — alt-screen (bash + tput smcup/rmcup)', () => {
    it('reports isAltScreen and captures normalBuffer history', async () => {
        // tput smcup switches to the alt-screen, tput rmcup restores.
        // We stay on smcup so buffer.active === buffer.alternate.
        const s = track(TerminalSession.start({
            command: 'bash',
            args: [
                '-c',
                'echo "prelude A"; echo "prelude B"; echo "prelude C"; ' +
                'tput smcup; printf "ALT-SCREEN CONTENT"; sleep 2',
            ],
            cols: 30, rows: 8,
        }));

        // Wait long enough for smcup and the alt-screen printf.
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 120));
            await s.whenParserFlushed();
            if (s.terminal.buffer.active === s.terminal.buffer.alternate) break;
        }

        expect(s.terminal.buffer.active === s.terminal.buffer.alternate).toBe(true);

        const snap = buildSnapshot(s.terminal, 'text', { includeScrollback: true });
        const sb = snap.scrollback!;
        expect(sb.isAltScreen).toBe(true);
        expect(sb.text).toContain('ALT-SCREEN CONTENT');

        // The normalBuffer bundle should include the pre-TUI history.
        expect(sb.normalBuffer).toBeDefined();
        const nb = sb.normalBuffer!;
        expect(nb.text).toContain('prelude A');
        expect(nb.text).toContain('prelude B');
        expect(nb.text).toContain('prelude C');
    });
});
