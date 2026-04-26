/**
 * Monitor — records frame-level diffs of a session's screen state over
 * a window of time.  Used to observe animations, scrolling, spinners
 * or any change an agent wants to "see" progress on.
 *
 * Implementation: every `intervalMs` we take a text snapshot, compare
 * to the previous stored frame, and record only the diff.  The full
 * text of each "key frame" (first frame and any frame where the
 * snapshot changed) is stored too, so an agent can reconstruct the
 * screen at any point in the recording.
 *
 * We intentionally skip `ansi` / `cells` formats to keep memory usage
 * small — monitors can run for a long time.  Agents that need colour
 * info can take a one-off `snapshot` instead.
 */

import { buildSnapshot, type Snapshot } from '../snapshot/snapshot.js';
import { diffSnapshots, type SnapshotDiff } from '../snapshot/diff.js';
import type { TerminalSession } from '../session/terminal-session.js';

export interface MonitorFrame {
    /** Unix ms timestamp when this frame was captured. */
    takenAt: number;
    /** ms offset from monitor start. */
    offsetMs: number;
    /** Whether anything changed vs the previous frame. */
    changed: boolean;
    /** Full text for this frame — always recorded so agents can replay. */
    text: string;
    /** Cursor position at this frame. */
    cursor: { row: number; col: number; visible: boolean };
    /** Per-row diff vs the previous frame. */
    diff: SnapshotDiff;
}

export interface MonitorResult {
    monitorId: string;
    sessionId: string;
    /** Total frames recorded (including unchanged frames — see `keepIdenticalFrames`). */
    frameCount: number;
    /** Only frames where `changed` is true. */
    changedFrameCount: number;
    /** Duration of the recording in ms. */
    durationMs: number;
    frames: MonitorFrame[];
    /** Hit maxFrames — frames from the tail were dropped. */
    truncated: boolean;
}

export interface MonitorOptions {
    /** Sampling interval in ms.  Default 100 (≈10 Hz). */
    intervalMs?: number;
    /**
     * If false (default) we only record frames where the snapshot
     * changed — drastically reduces memory for idle sessions.  If true
     * we keep every sample even when nothing moved.
     */
    keepIdenticalFrames?: boolean;
    /**
     * Hard cap on recorded frames; older frames are dropped from the
     * head when exceeded.  Default 5000.
     */
    maxFrames?: number;
}

let monitorIdCounter = 0;
function nextMonitorId(): string {
    monitorIdCounter += 1;
    return `mon-${Date.now().toString(36)}-${monitorIdCounter}`;
}

/** A single running monitor.  Owned by `SessionManager`. */
export class Monitor {
    readonly id: string;
    readonly sessionId: string;

    private readonly session: TerminalSession;
    private readonly intervalMs: number;
    private readonly keepIdentical: boolean;
    private readonly maxFrames: number;

    private startAt = 0;
    private timer: NodeJS.Timeout | null = null;
    private prevSnapshot: Snapshot | null = null;
    private frames: MonitorFrame[] = [];
    private truncated = false;
    private stopped = false;

    constructor(session: TerminalSession, opts: MonitorOptions = {}) {
        this.id = nextMonitorId();
        this.sessionId = session.id;
        this.session = session;
        this.intervalMs = Math.max(16, Math.floor(opts.intervalMs ?? 100));
        this.keepIdentical = !!opts.keepIdenticalFrames;
        this.maxFrames = Math.max(1, Math.floor(opts.maxFrames ?? 5000));
    }

    /** Begin sampling.  Safe to call at most once. */
    start(): void {
        if (this.timer !== null || this.stopped) return;
        this.startAt = Date.now();
        // Kick off an immediate sample so callers see frame 0 within one
        // interval rather than two.
        void this.sampleNow();
        this.timer = setInterval(() => void this.sampleNow(), this.intervalMs);
    }

    async sampleNow(): Promise<void> {
        if (this.stopped) return;
        try {
            await this.session.whenParserFlushed();
            if (this.stopped) return;
            const snap = buildSnapshot(this.session.terminal, 'text');
            const diff = diffSnapshots(this.prevSnapshot, snap);
            const changed = !diff.identical;
            if (changed || this.keepIdentical) {
                const frame: MonitorFrame = {
                    takenAt: snap.takenAt,
                    offsetMs: snap.takenAt - this.startAt,
                    changed,
                    text: snap.text,
                    cursor: { ...snap.cursor },
                    diff,
                };
                this.frames.push(frame);
                while (this.frames.length > this.maxFrames) {
                    this.frames.shift();
                    this.truncated = true;
                }
            }
            this.prevSnapshot = snap;
        } catch {
            // Snapshot failed (session maybe exited) — just skip this tick.
        }
    }

    /** Stop sampling and return the recorded frames. */
    stop(): MonitorResult {
        if (this.stopped) {
            return this.buildResult();
        }
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        return this.buildResult();
    }

    private buildResult(): MonitorResult {
        const changedCount = this.frames.reduce((n, f) => n + (f.changed ? 1 : 0), 0);
        return {
            monitorId: this.id,
            sessionId: this.sessionId,
            frameCount: this.frames.length,
            changedFrameCount: changedCount,
            durationMs: this.startAt ? (Date.now() - this.startAt) : 0,
            frames: [...this.frames],
            truncated: this.truncated,
        };
    }
}
