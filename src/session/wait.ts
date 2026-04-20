/**
 * Higher-level "wait for something" helpers built on top of a
 * TerminalSession.  Kept in a separate module so the core session
 * object stays focused on the PTY ↔ emulator plumbing.
 */

import { buildSnapshot } from '../snapshot/snapshot.js';
import type { TerminalSession } from './terminal-session.js';

export class WaitTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WaitTimeoutError';
    }
}

export interface WaitForTextOptions {
    /**
     * Pattern to wait for — either a literal substring or a RegExp.
     * Strings are matched case-sensitively by default; pass a RegExp
     * for case-insensitive / anchored matches.
     */
    pattern: string | RegExp;
    /** Max time to wait in ms.  Default 10 000. */
    timeoutMs?: number;
    /**
     * How often to re-check the screen.  Default 50 ms — low enough to
     * feel instant to an agent, high enough not to burn CPU.
     */
    pollIntervalMs?: number;
    /**
     * If true (default) the pattern is tested against the current
     * visible screen text.  If false it's tested against the full raw
     * output buffer (useful for patterns that scrolled off-screen).
     */
    matchScreen?: boolean;
}

export interface WaitForTextResult {
    matched: true;
    /** The matched substring (for strings) or RegExp match array. */
    match: string | RegExpMatchArray;
    /** Total ms between start and match. */
    elapsedMs: number;
    /** Screen text at the time of the match. */
    screenText: string;
}

/**
 * Block until the given pattern appears on screen (or in the raw
 * buffer).  Rejects with `WaitTimeoutError` on timeout.
 */
export async function waitForText(
    session: TerminalSession,
    opts: WaitForTextOptions,
): Promise<WaitForTextResult> {
    const start = Date.now();
    const timeout = Math.max(1, opts.timeoutMs ?? 10_000);
    const pollInterval = Math.max(10, opts.pollIntervalMs ?? 50);
    const matchScreen = opts.matchScreen !== false;

    const testOnce = (): WaitForTextResult | null => {
        let text: string;
        if (matchScreen) {
            const snap = buildSnapshot(session.terminal, 'text');
            text = snap.text;
        } else {
            text = session.rawOutput();
        }
        if (typeof opts.pattern === 'string') {
            if (text.includes(opts.pattern)) {
                return {
                    matched: true,
                    match: opts.pattern,
                    elapsedMs: Date.now() - start,
                    screenText: text,
                };
            }
        } else {
            const m = text.match(opts.pattern);
            if (m) {
                return {
                    matched: true,
                    match: m,
                    elapsedMs: Date.now() - start,
                    screenText: text,
                };
            }
        }
        return null;
    };

    // First, opportunistic check — pattern may already be on screen.
    await session.whenParserFlushed();
    const immediate = testOnce();
    if (immediate) return immediate;

    return new Promise<WaitForTextResult>((resolve, reject) => {
        let timeoutHandle: NodeJS.Timeout | null = null;
        let intervalHandle: NodeJS.Timeout | null = null;
        const cleanup = () => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (intervalHandle) clearInterval(intervalHandle);
        };

        intervalHandle = setInterval(async () => {
            try {
                await session.whenParserFlushed();
                const result = testOnce();
                if (result) {
                    cleanup();
                    resolve(result);
                }
            } catch (err) {
                cleanup();
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        }, pollInterval);

        timeoutHandle = setTimeout(() => {
            cleanup();
            const patternStr = typeof opts.pattern === 'string'
                ? JSON.stringify(opts.pattern)
                : opts.pattern.toString();
            reject(new WaitTimeoutError(
                `wait_for_text: pattern ${patternStr} did not appear within ${timeout}ms`,
            ));
        }, timeout);
    });
}

export interface WaitForIdleOptions {
    /** The session has to go this long with no output to count as idle.  Default 500. */
    idleMs?: number;
    /** Max wall-clock wait time.  Default 10 000 ms. */
    timeoutMs?: number;
    /** Check frequency in ms.  Default 50. */
    pollIntervalMs?: number;
}

export interface WaitForIdleResult {
    idleFor: number;
    elapsedMs: number;
}

/**
 * Block until the session has produced no output for `idleMs` ms.
 * Useful between a "send keys" and a subsequent snapshot: gives the
 * TUI time to render before the agent inspects the screen.
 */
export async function waitForIdle(
    session: TerminalSession,
    opts: WaitForIdleOptions = {},
): Promise<WaitForIdleResult> {
    const start = Date.now();
    const idleMs = Math.max(10, opts.idleMs ?? 500);
    const timeoutMs = Math.max(idleMs, opts.timeoutMs ?? 10_000);
    const pollInterval = Math.max(10, Math.min(opts.pollIntervalMs ?? 50, idleMs));

    return new Promise<WaitForIdleResult>((resolve, reject) => {
        let timeoutHandle: NodeJS.Timeout | null = null;
        let intervalHandle: NodeJS.Timeout | null = null;
        const cleanup = () => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (intervalHandle) clearInterval(intervalHandle);
        };

        intervalHandle = setInterval(async () => {
            try {
                await session.whenParserFlushed();
                const sinceLast = Date.now() - session.lastOutputAt;
                if (sinceLast >= idleMs) {
                    cleanup();
                    resolve({ idleFor: sinceLast, elapsedMs: Date.now() - start });
                }
            } catch (err) {
                cleanup();
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        }, pollInterval);

        timeoutHandle = setTimeout(() => {
            cleanup();
            reject(new WaitTimeoutError(
                `wait_for_idle: terminal still producing output after ${timeoutMs}ms`,
            ));
        }, timeoutMs);
    });
}

export interface HoldKeyOptions {
    /** Total ms to hold the key for. */
    durationMs: number;
    /**
     * Gap between simulated key-repeat events.  Default 30 ms — matches
     * the common OS auto-repeat rate so tests of acceleration features
     * produce realistic curves.
     */
    intervalMs?: number;
}

/**
 * Simulate holding a key for a duration by sending the encoded bytes
 * repeatedly at a configurable cadence.  Resolves once the hold has
 * elapsed and every send has been flushed by the parser.
 */
export async function holdKey(
    session: TerminalSession,
    keyBytes: string,
    opts: HoldKeyOptions,
): Promise<{ events: number }> {
    const duration = Math.max(1, opts.durationMs);
    const interval = Math.max(5, opts.intervalMs ?? 30);

    const deadline = Date.now() + duration;
    let events = 0;
    // Fire one right away so the first event is at t=0 (matches real key-repeat).
    session.writeRaw(keyBytes);
    events += 1;

    return new Promise<{ events: number }>((resolve) => {
        const timer = setInterval(() => {
            if (Date.now() >= deadline) {
                clearInterval(timer);
                void session.whenParserFlushed().then(() => {
                    resolve({ events });
                });
                return;
            }
            try {
                session.writeRaw(keyBytes);
                events += 1;
            } catch {
                // Session died mid-hold — stop gracefully.
                clearInterval(timer);
                resolve({ events });
            }
        }, interval);
    });
}

export interface TypeTextOptions {
    /** Characters per second.  Default 80 (feels fast-but-human). */
    cps?: number;
}

/** Type a string with realistic per-char delays. */
export async function typeText(
    session: TerminalSession,
    text: string,
    opts: TypeTextOptions = {},
): Promise<void> {
    const cps = Math.max(1, opts.cps ?? 80);
    const gap = Math.floor(1000 / cps);
    for (const ch of text) {
        session.writeRaw(ch);
        if (gap > 0) {
            await new Promise<void>((r) => setTimeout(r, gap));
        }
    }
    await session.whenParserFlushed();
}
