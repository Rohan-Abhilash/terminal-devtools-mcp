/**
 * captureAround — take a snapshot of the terminal, run an input-sending
 * action, wait for the emulator to catch up (and optionally let the TUI
 * settle for a short period or poll for a specific pattern), then take
 * a second snapshot and diff the two.
 *
 * Used by the input tools (`send_keys`, `send_text`, `send_raw`,
 * `hold_key`, `type_text`) so every call returns:
 *
 *   • what the screen looked like before the input was submitted,
 *   • what it looks like after, and
 *   • a compact row-level diff of what changed.
 *
 * When the caller passes a `waitFor` spec, the helper *also* polls the
 * screen for that pattern after the action and snapshots the moment it
 * appears — that way an agent can land an input AND observe a transient
 * post-input state (a "loading…" line that flips to "done", a prompt
 * that flashes for a few hundred ms, a spinner that resolves) without
 * racing a separate `wait_for_text` round-trip.
 *
 * This is the single most useful observation any TUI-driving agent can
 * have — it makes every keystroke self-describing, and lets the caller
 * verify the input actually did what it was supposed to do.
 */
import type { TerminalSession } from '../session/terminal-session.js';
import { buildSnapshot } from '../snapshot/snapshot.js';
import { diffSnapshots, type SnapshotDiff } from '../snapshot/diff.js';

/**
 * Result returned by {@link captureAround}.  Bundled under a single
 * `screen` key in the tool payloads so it's easy to ignore when not
 * needed and easy to find when it is.
 */
export interface CaptureResult {
    /** Screen state immediately before the action was executed. */
    before: {
        text: string;
        lines: string[];
        cursor: { row: number; col: number; visible: boolean };
        cols: number;
        rows: number;
    };
    /** Screen state after the action + parser flush + settle window
     *  (or — when `waitFor` is provided — the moment the pattern was
     *  detected). */
    after: {
        text: string;
        lines: string[];
        cursor: { row: number; col: number; visible: boolean };
        cols: number;
        rows: number;
    };
    /** Compact description of what changed between the two snapshots. */
    diff: SnapshotDiff;
    /** How long we waited (ms) after flush before taking the `after`
     *  snapshot.  0 when `waitFor` was provided (polling replaces the
     *  fixed settle window). */
    waitAfterMs: number;
    /** Time (ms) from just before the action to just after the second
     *  snapshot — total observation window. */
    totalMs: number;
}

/**
 * Outcome of the `waitFor` polling loop — reported alongside the
 * capture result so the caller knows whether the pattern landed within
 * the timeout window.
 */
export interface WaitForOutcome {
    /** Echo of the pattern the caller asked about (stringified). */
    pattern: string;
    /** True if the pattern appeared on screen (or in raw output) before the timeout. */
    matched: boolean;
    /**
     * When matched and `pattern` was a string, this is that string.
     * When matched and `pattern` was a RegExp, this is the full match
     * plus any capture groups (Array.from on the RegExpMatchArray).
     * Null on timeout.
     */
    match: string | string[] | null;
    /** Wall-clock ms from the start of polling to match (or timeout). */
    elapsedMs: number;
    /** True when the poll window elapsed without a match. */
    timedOut: boolean;
    /** The effective timeout applied (ms). */
    timeoutMs: number;
    /** Which buffer we polled against — mirrors the `matchScreen` option. */
    matchedAgainst: 'screen' | 'raw';
}

export interface WaitForSpec {
    /** Pattern to wait for.  Can be a literal substring or a RegExp. */
    pattern: string | RegExp;
    /** Max time to poll in ms.  Default 5 000.  Clamped to [10, 600 000]. */
    timeoutMs?: number;
    /** Time between polls in ms.  Default 50.  Clamped to [10, 5 000]. */
    pollIntervalMs?: number;
    /**
     * When true (default) the pattern is tested against the current
     * visible screen text.  When false it's tested against the raw PTY
     * output buffer — useful when the pattern scrolls past the visible
     * viewport before the next poll tick.
     */
    matchScreen?: boolean;
    /**
     * When true, a timeout causes `captureAround` to throw.  When false
     * (default) the `after` snapshot is still taken and the outcome is
     * reported as `matched: false, timedOut: true`, letting the caller
     * decide how to handle the miss.
     */
    errorOnTimeout?: boolean;
}

export interface CaptureOptions {
    /**
     * When false, the action still runs and the parser is still flushed,
     * but no snapshots are taken and no diff is computed.  Default true.
     */
    enabled?: boolean;
    /**
     * After the action runs and the xterm parser drains, wait this many
     * ms before taking the "after" snapshot.  Lets a TUI that reacts to
     * input a frame later (e.g. Ink re-renders on the next tick) show
     * the updated screen.  Default 150.  Clamped to [0, 5000].
     *
     * IGNORED when `waitFor` is provided — polling replaces the fixed
     * settle window so we capture the screen the moment the pattern
     * appears.
     */
    waitAfterMs?: number;
    /**
     * When provided, after the action runs the helper polls the screen
     * (or raw output) for this pattern and snapshots immediately on
     * match.  See {@link WaitForSpec}.
     */
    waitFor?: WaitForSpec;
}

export class WaitForTimeoutError extends Error {
    public readonly pattern: string;
    public readonly timeoutMs: number;

    constructor(pattern: string, timeoutMs: number) {
        super(`waitFor: pattern ${pattern} did not appear within ${timeoutMs}ms`);
        this.name = 'WaitForTimeoutError';
        this.pattern = pattern;
        this.timeoutMs = timeoutMs;
    }
}

const DEFAULT_WAIT_MS = 150;
const MAX_WAIT_MS = 5000;

const DEFAULT_WAIT_FOR_TIMEOUT_MS = 5000;
const MAX_WAIT_FOR_TIMEOUT_MS = 600_000;
const MIN_WAIT_FOR_TIMEOUT_MS = 10;
const DEFAULT_WAIT_FOR_POLL_MS = 50;
const MAX_WAIT_FOR_POLL_MS = 5000;
const MIN_WAIT_FOR_POLL_MS = 10;

/**
 * Run `action`, sandwiching it between two text-snapshots of the given
 * session.  The action is expected to issue PTY writes (directly or via
 * a helper like `typeText`).  We:
 *
 *   1. Flush the parser so the "before" snapshot is up-to-date.
 *   2. Take the "before" snapshot.
 *   3. Run the action and await its promise (if any).
 *   4. Flush the parser again (bytes sent by the action are now in the
 *      emulator buffer).
 *   5. EITHER sleep `waitAfterMs` and flush again — the default — OR,
 *      when `waitFor` is provided, poll the screen for the pattern
 *      until it appears or the `waitFor.timeoutMs` deadline is hit.
 *   6. Take the "after" snapshot and diff.
 *
 * Always returns the capture result.  When `waitFor` is provided, the
 * outcome of the poll is returned via the second tuple element; the
 * caller surfaces it to the MCP client.
 */
export async function captureAround(
    session: TerminalSession,
    action: () => void | Promise<void>,
    opts: CaptureOptions = {},
): Promise<{ capture: CaptureResult | null; waitFor: WaitForOutcome | null }> {
    const enabled = opts.enabled !== false;
    const waitForSpec = opts.waitFor;
    const waitAfterMs = waitForSpec
        ? 0
        : Math.max(0, Math.min(opts.waitAfterMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS));

    // ── Disabled capture but `waitFor` is still requested ──────────
    // We still run the action, flush, and poll — the caller gets the
    // wait outcome without the before/after payload.
    if (!enabled && !waitForSpec) {
        const r = action();
        if (r && typeof (r as Promise<void>).then === 'function') {
            await r;
        }
        await session.whenParserFlushed();
        return { capture: null, waitFor: null };
    }

    const started = Date.now();

    // The "before" snapshot is always useful — even for the
    // `enabled=false` + `waitFor` case — so we take it whenever the
    // caller asks to observe anything.  It doesn't appear in the
    // payload when `enabled=false`, but we still want a reliable
    // starting state.
    await session.whenParserFlushed();
    const beforeSnap = enabled ? buildSnapshot(session.terminal, 'text') : null;

    const actionResult = action();
    if (actionResult && typeof (actionResult as Promise<void>).then === 'function') {
        await actionResult;
    }

    await session.whenParserFlushed();

    let waitForOutcome: WaitForOutcome | null = null;

    if (waitForSpec) {
        waitForOutcome = await pollForPattern(session, waitForSpec);
        if (waitForOutcome.timedOut && waitForSpec.errorOnTimeout) {
            throw new WaitForTimeoutError(
                waitForOutcome.pattern,
                waitForOutcome.timeoutMs,
            );
        }
    } else if (waitAfterMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitAfterMs));
        await session.whenParserFlushed();
    }

    if (!enabled) {
        return { capture: null, waitFor: waitForOutcome };
    }

    const afterSnap = buildSnapshot(session.terminal, 'text');
    const diff = diffSnapshots(beforeSnap!, afterSnap);

    const capture: CaptureResult = {
        before: {
            text: beforeSnap!.text,
            lines: beforeSnap!.lines,
            cursor: beforeSnap!.cursor,
            cols: beforeSnap!.cols,
            rows: beforeSnap!.rows,
        },
        after: {
            text: afterSnap.text,
            lines: afterSnap.lines,
            cursor: afterSnap.cursor,
            cols: afterSnap.cols,
            rows: afterSnap.rows,
        },
        diff,
        waitAfterMs,
        totalMs: Date.now() - started,
    };

    return { capture, waitFor: waitForOutcome };
}

/**
 * Poll the emulator (or raw output buffer) for the given pattern until
 * it appears or the timeout elapses.  Used by `captureAround` when a
 * `waitFor` spec is supplied.
 */
async function pollForPattern(
    session: TerminalSession,
    spec: WaitForSpec,
): Promise<WaitForOutcome> {
    const timeoutMs = Math.max(
        MIN_WAIT_FOR_TIMEOUT_MS,
        Math.min(spec.timeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS, MAX_WAIT_FOR_TIMEOUT_MS),
    );
    const pollIntervalMs = Math.max(
        MIN_WAIT_FOR_POLL_MS,
        Math.min(spec.pollIntervalMs ?? DEFAULT_WAIT_FOR_POLL_MS, MAX_WAIT_FOR_POLL_MS),
    );
    const matchScreen = spec.matchScreen !== false;
    const matchedAgainst: 'screen' | 'raw' = matchScreen ? 'screen' : 'raw';

    const patternStr = typeof spec.pattern === 'string'
        ? spec.pattern
        : spec.pattern.toString();

    const started = Date.now();

    const check = (): { match: string | string[]; } | null => {
        const haystack = matchScreen
            ? buildSnapshot(session.terminal, 'text').text
            : session.rawOutput();
        if (typeof spec.pattern === 'string') {
            if (haystack.includes(spec.pattern)) {
                return { match: spec.pattern };
            }
            return null;
        }
        const m = haystack.match(spec.pattern);
        if (m) {
            // Array.from preserves the full match + capture groups as a
            // plain string[] for wire transport.
            return { match: Array.from(m) };
        }
        return null;
    };

    // Opportunistic first check — pattern may already be there.
    await session.whenParserFlushed();
    const immediate = check();
    if (immediate) {
        return {
            pattern: patternStr,
            matched: true,
            match: immediate.match,
            elapsedMs: Date.now() - started,
            timedOut: false,
            timeoutMs,
            matchedAgainst,
        };
    }

    return new Promise<WaitForOutcome>((resolve) => {
        let timeoutHandle: NodeJS.Timeout | null = null;
        let intervalHandle: NodeJS.Timeout | null = null;
        const cleanup = () => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (intervalHandle) clearInterval(intervalHandle);
        };

        intervalHandle = setInterval(async () => {
            try {
                await session.whenParserFlushed();
                const r = check();
                if (r) {
                    cleanup();
                    resolve({
                        pattern: patternStr,
                        matched: true,
                        match: r.match,
                        elapsedMs: Date.now() - started,
                        timedOut: false,
                        timeoutMs,
                        matchedAgainst,
                    });
                }
            } catch {
                // Swallow poll-iteration errors; the timeout will fire.
            }
        }, pollIntervalMs);

        timeoutHandle = setTimeout(() => {
            cleanup();
            resolve({
                pattern: patternStr,
                matched: false,
                match: null,
                elapsedMs: Date.now() - started,
                timedOut: true,
                timeoutMs,
                matchedAgainst,
            });
        }, timeoutMs);
    });
}
