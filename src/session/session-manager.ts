/**
 * SessionManager — owns every live TerminalSession and every Monitor.
 * Enforces concurrency limits, provides lookup by id, and on MCP
 * server shutdown makes sure every PTY is killed and every monitor
 * stopped so we don't leave orphan processes behind.
 *
 * Intentionally small: most logic lives in TerminalSession / Monitor —
 * this class is the glue.
 */

import { Monitor, type MonitorOptions, type MonitorResult } from '../monitor/monitor.js';
import { TerminalSession } from './terminal-session.js';
import type { StartSessionOptions, SessionInfo } from './types.js';

export class SessionNotFoundError extends Error {
    constructor(id: string) {
        super(`Session not found: ${id}`);
        this.name = 'SessionNotFoundError';
    }
}

export class MonitorNotFoundError extends Error {
    constructor(id: string) {
        super(`Monitor not found: ${id}`);
        this.name = 'MonitorNotFoundError';
    }
}

export class SessionLimitError extends Error {
    constructor(limit: number) {
        super(`Session limit reached (${limit} concurrent sessions). Close a session first.`);
        this.name = 'SessionLimitError';
    }
}

export interface SessionManagerOptions {
    /** Max concurrently-running sessions.  Default 32. */
    maxSessions?: number;
    /** Max concurrently-running monitors.  Default 16. */
    maxMonitors?: number;
}

export class SessionManager {
    private readonly sessions = new Map<string, TerminalSession>();
    private readonly monitors = new Map<string, Monitor>();
    private readonly maxSessions: number;
    private readonly maxMonitors: number;
    private shuttingDown = false;

    constructor(opts: SessionManagerOptions = {}) {
        this.maxSessions = Math.max(1, opts.maxSessions ?? 32);
        this.maxMonitors = Math.max(1, opts.maxMonitors ?? 16);
    }

    /** Spawn a new terminal session.  Throws if the limit is reached. */
    start(opts: StartSessionOptions): TerminalSession {
        if (this.shuttingDown) {
            throw new Error('SessionManager is shutting down — cannot start new sessions');
        }
        if (this.sessions.size >= this.maxSessions) {
            throw new SessionLimitError(this.maxSessions);
        }
        const session = TerminalSession.start(opts);
        this.sessions.set(session.id, session);
        // Cleanup registration when the process exits naturally.
        session.onExit(() => {
            // Keep the session in the map briefly so callers can still read
            // its final snapshot / bytesOut.  The manager holds onto it
            // until the caller explicitly closes it via `stop()` or we
            // sweep on shutdown.  This mirrors how Chrome DevTools keeps
            // a crashed target around for post-mortem.
        });
        return session;
    }

    /** Get a session by id, or throw. */
    get(id: string): TerminalSession {
        const s = this.sessions.get(id);
        if (!s) throw new SessionNotFoundError(id);
        return s;
    }

    /** Does a session with this id exist (alive or not)? */
    has(id: string): boolean {
        return this.sessions.has(id);
    }

    /** List every session currently tracked. */
    list(): SessionInfo[] {
        return Array.from(this.sessions.values()).map((s) => s.info());
    }

    /**
     * Stop and drop a session.  Safe to call on an already-exited session
     * (clean-up proceeds; no-op if not tracked).
     */
    async stop(id: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
        const s = this.sessions.get(id);
        if (!s) return;
        // Any monitors attached to this session must be stopped first.
        for (const [mid, monitor] of this.monitors) {
            if (monitor.sessionId === id) {
                monitor.stop();
                this.monitors.delete(mid);
            }
        }
        await s.stop(signal);
        this.sessions.delete(id);
    }

    // ── Monitors ───────────────────────────────────────────────────

    startMonitor(sessionId: string, opts?: MonitorOptions): Monitor {
        const session = this.get(sessionId);
        if (this.monitors.size >= this.maxMonitors) {
            throw new Error(
                `Monitor limit reached (${this.maxMonitors}).  Stop another monitor first.`,
            );
        }
        const monitor = new Monitor(session, opts);
        this.monitors.set(monitor.id, monitor);
        monitor.start();
        return monitor;
    }

    stopMonitor(monitorId: string): MonitorResult {
        const monitor = this.monitors.get(monitorId);
        if (!monitor) throw new MonitorNotFoundError(monitorId);
        const result = monitor.stop();
        this.monitors.delete(monitorId);
        return result;
    }

    /** List active monitors. */
    listMonitors(): Array<{ monitorId: string; sessionId: string }> {
        return Array.from(this.monitors.values()).map((m) => ({
            monitorId: m.id,
            sessionId: m.sessionId,
        }));
    }

    // ── Shutdown ───────────────────────────────────────────────────

    /** Kill every session + monitor.  Idempotent. */
    async shutdown(): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        for (const monitor of this.monitors.values()) monitor.stop();
        this.monitors.clear();
        const kills: Array<Promise<void>> = [];
        for (const session of this.sessions.values()) {
            kills.push(session.stop('SIGTERM').catch(() => { /* ignore */ }));
        }
        await Promise.allSettled(kills);
        this.sessions.clear();
    }
}
