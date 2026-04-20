/**
 * Unit tests for `captureAround` — the helper that sandwiches an action
 * between two text snapshots, optionally polls for a pattern to appear
 * after the action, and diffs the snapshots.
 *
 * These are pure-logic tests using a real PTY (via TerminalSession) so
 * we exercise the parser-flush + settle timing exactly as the tool
 * handlers do.
 */

import { afterEach, describe, expect, it } from '@jest/globals';

import { TerminalSession } from '../../src/session/terminal-session.js';
import {
    captureAround,
    WaitForTimeoutError,
} from '../../src/server/capture.js';

let openSessions: TerminalSession[] = [];

afterEach(async () => {
    await Promise.all(openSessions.map((s) => s.stop('SIGKILL').catch(() => { /* ignore */ })));
    openSessions = [];
});

function track(s: TerminalSession): TerminalSession {
    openSessions.push(s);
    return s;
}

/** Start `cat` (echoes input in cooked mode) and wait for the PTY. */
async function startCat(): Promise<TerminalSession> {
    const s = track(TerminalSession.start({
        command: 'bash',
        args: ['-c', 'exec cat'],
        cols: 40, rows: 6,
    }));
    await new Promise((r) => setTimeout(r, 120));
    return s;
}

describe('captureAround — enabled (default)', () => {
    it('returns before, after, diff, and timing metadata', async () => {
        const s = await startCat();

        const { capture, waitFor } = await captureAround(s, () => {
            s.writeRaw('hello');
        });

        expect(capture).not.toBeNull();
        expect(waitFor).toBeNull();
        const r = capture!;

        // Shape
        expect(r.before).toBeDefined();
        expect(r.after).toBeDefined();
        expect(r.diff).toBeDefined();

        // The PTY echoes 'hello' in cooked mode.
        expect(r.before.text).not.toContain('hello');
        expect(r.after.text).toContain('hello');

        // Dimensions preserved.
        expect(r.before.cols).toBe(40);
        expect(r.before.rows).toBe(6);
        expect(r.after.cols).toBe(40);
        expect(r.after.rows).toBe(6);

        // Diff should not be identical, should not be resized, should
        // have at least one changed line containing 'hello'.
        expect(r.diff.identical).toBe(false);
        expect(r.diff.resized).toBe(false);
        expect(r.diff.changedLines.some((c) => c.after.includes('hello'))).toBe(true);

        // Timing
        expect(r.waitAfterMs).toBe(150); // default
        expect(r.totalMs).toBeGreaterThanOrEqual(150);
    });

    it('awaits the action when it returns a promise', async () => {
        const s = await startCat();

        const { capture } = await captureAround(s, async () => {
            s.writeRaw('a');
            await new Promise((res) => setTimeout(res, 40));
            s.writeRaw('b');
            await new Promise((res) => setTimeout(res, 40));
            s.writeRaw('c');
        });

        const r = capture!;
        // Both characters must be on screen by the time we snapshot.
        expect(r.after.text).toContain('abc');
    });
});

describe('captureAround — disabled', () => {
    it('returns null capture when enabled=false but still runs the action', async () => {
        const s = await startCat();

        const { capture, waitFor } = await captureAround(s, () => {
            s.writeRaw('quiet');
        }, { enabled: false });

        expect(capture).toBeNull();
        expect(waitFor).toBeNull();

        // The action still ran — the bytes left our side and the PTY
        // will have echoed them shortly.  Give the echo round-trip a
        // moment (disabled capture skips the settle window by design).
        const { waitForText } = await import('../../src/session/wait.js');
        await waitForText(s, { pattern: 'quiet', timeoutMs: 1500 });
    });
});

describe('captureAround — waitAfterMs clamping', () => {
    it('clamps waitAfterMs to 0 minimum', async () => {
        const s = await startCat();
        const { capture } = await captureAround(s, () => { s.writeRaw('z'); }, {
            waitAfterMs: -50,
        });
        expect(capture!.waitAfterMs).toBe(0);
    });

    it('clamps waitAfterMs to the 5000ms max', async () => {
        const s = await startCat();
        const started = Date.now();
        const { capture } = await captureAround(s, () => { s.writeRaw('z'); }, {
            waitAfterMs: 999_999,
        });
        const took = Date.now() - started;
        expect(capture!.waitAfterMs).toBe(5000);
        // Sanity: shouldn't actually run for a million ms :-)
        expect(took).toBeLessThan(6000);
    });

    it('respects waitAfterMs=0 (tight capture)', async () => {
        const s = await startCat();
        const started = Date.now();
        const { capture } = await captureAround(s, () => { s.writeRaw('z'); }, {
            waitAfterMs: 0,
        });
        const took = Date.now() - started;
        expect(capture!.waitAfterMs).toBe(0);
        // Tight capture with nothing asynchronous should return fast.
        expect(took).toBeLessThan(150);
    });
});

describe('captureAround — no-op action', () => {
    it('reports identical=true when the action does not change the screen', async () => {
        const s = await startCat();
        const { capture } = await captureAround(s, () => { /* no-op */ });
        expect(capture!.diff.identical).toBe(true);
        expect(capture!.diff.changedLines).toEqual([]);
        expect(capture!.diff.resized).toBe(false);
    });
});

// ── waitFor — the post-action polling feature ──────────────────────────

/** Start a bash echo-on-newline session that produces specific strings. */
async function startEchoer(script: string, cols = 60, rows = 10): Promise<TerminalSession> {
    const s = track(TerminalSession.start({
        command: 'bash',
        args: ['-c', script],
        cols, rows,
    }));
    await new Promise((r) => setTimeout(r, 120));
    return s;
}

describe('captureAround — waitFor (substring match)', () => {
    it('returns as soon as the pattern is first seen on screen', async () => {
        // Echo a "pending" line immediately, then "DONE" after 600 ms.
        const s = await startEchoer(
            'printf "pending...\\n"; sleep 0.6; printf "DONE\\n"; exec cat',
        );

        const started = Date.now();
        const { capture, waitFor } = await captureAround(s, () => {
            // No-op — we're just waiting for the "DONE" the script emits
            // on its own.  The waitFor feature is independent of the
            // action kind.
        }, {
            waitFor: { pattern: 'DONE', timeoutMs: 3000, pollIntervalMs: 20 },
        });

        const elapsed = Date.now() - started;
        expect(waitFor).not.toBeNull();
        expect(waitFor!.matched).toBe(true);
        expect(waitFor!.match).toBe('DONE');
        expect(waitFor!.timedOut).toBe(false);
        expect(waitFor!.pattern).toBe('DONE');
        expect(waitFor!.matchedAgainst).toBe('screen');

        // Should have matched roughly when the echoer printed DONE.
        expect(elapsed).toBeGreaterThan(400);
        expect(elapsed).toBeLessThan(2500);

        // waitAfterMs is zero when waitFor is used.
        expect(capture!.waitAfterMs).toBe(0);
        // The after-snapshot was timed to the match, so "DONE" is there.
        expect(capture!.after.text).toContain('DONE');
    });

    it('works without captureScreen but still reports the waitFor outcome', async () => {
        const s = await startEchoer('sleep 0.3; printf "MARK\\n"; exec cat');

        const { capture, waitFor } = await captureAround(s, () => { /* no action */ }, {
            enabled: false,
            waitFor: { pattern: 'MARK', timeoutMs: 2000, pollIntervalMs: 20 },
        });

        expect(capture).toBeNull();
        expect(waitFor).not.toBeNull();
        expect(waitFor!.matched).toBe(true);
        expect(waitFor!.match).toBe('MARK');
    });

    it('reports timedOut=true when the pattern never appears', async () => {
        const s = await startEchoer('printf "hello\\n"; exec cat');

        const started = Date.now();
        const { capture, waitFor } = await captureAround(s, () => { /* no-op */ }, {
            waitFor: { pattern: 'NEVER_EMITTED', timeoutMs: 300, pollIntervalMs: 30 },
        });
        const elapsed = Date.now() - started;

        expect(waitFor!.matched).toBe(false);
        expect(waitFor!.timedOut).toBe(true);
        expect(waitFor!.match).toBeNull();
        expect(waitFor!.timeoutMs).toBe(300);
        expect(elapsed).toBeGreaterThanOrEqual(290);
        expect(elapsed).toBeLessThan(900);

        // Capture still succeeds — the after-snapshot is taken when the
        // timeout fired.
        expect(capture).not.toBeNull();
        expect(capture!.after.text).toContain('hello');
    });

    it('throws WaitForTimeoutError when errorOnTimeout is set', async () => {
        const s = await startEchoer('printf "hello\\n"; exec cat');

        await expect(
            captureAround(s, () => { /* no-op */ }, {
                waitFor: {
                    pattern: 'NEVER_EMITTED',
                    timeoutMs: 200,
                    errorOnTimeout: true,
                },
            }),
        ).rejects.toBeInstanceOf(WaitForTimeoutError);
    });
});

describe('captureAround — waitFor (regex match)', () => {
    it('returns the full match + capture groups on a RegExp match', async () => {
        const s = await startEchoer(
            'sleep 0.1; printf "version=1.2.3\\n"; exec cat',
        );

        const { waitFor } = await captureAround(s, () => { /* no-op */ }, {
            waitFor: {
                pattern: /version=(\d+)\.(\d+)\.(\d+)/,
                timeoutMs: 2000,
                pollIntervalMs: 20,
            },
        });

        expect(waitFor!.matched).toBe(true);
        expect(Array.isArray(waitFor!.match)).toBe(true);
        const m = waitFor!.match as string[];
        expect(m[0]).toBe('version=1.2.3');
        expect(m[1]).toBe('1');
        expect(m[2]).toBe('2');
        expect(m[3]).toBe('3');
    });
});

describe('captureAround — waitFor (raw output)', () => {
    it('matches against the raw output buffer when matchScreen=false', async () => {
        const s = await startEchoer(
            // Emit a unique marker then clear the screen so it's not in
            // the visible viewport anymore — only the raw output buffer
            // retains it.
            'printf "UNIQUE_MARKER_123\\n"; sleep 0.1; printf "\\x1b[2J\\x1b[H"; sleep 0.2; printf "after\\n"; exec cat',
        );

        // Wait for the post-clear state before asking.
        await new Promise((r) => setTimeout(r, 500));
        await s.whenParserFlushed();

        const { waitFor } = await captureAround(s, () => { /* no-op */ }, {
            waitFor: {
                pattern: 'UNIQUE_MARKER_123',
                matchScreen: false,
                timeoutMs: 1000,
                pollIntervalMs: 30,
            },
        });

        expect(waitFor!.matched).toBe(true);
        expect(waitFor!.matchedAgainst).toBe('raw');
    });
});
