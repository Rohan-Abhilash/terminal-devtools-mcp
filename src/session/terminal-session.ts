/**
 * TerminalSession — a single live terminal attached to a spawned
 * process.  The PTY is produced by node-pty; the stream of bytes
 * coming out of it is piped both into an @xterm/headless emulator
 * (so we can render the screen state) and into a rolling raw-output
 * buffer (so callers can read the bytes directly if needed).
 *
 * Invariants:
 *   • `terminal.write(data, cb)` is awaited before any snapshot is
 *     taken, so the xterm parser has actually processed the bytes.
 *     We do this by maintaining a "pending writes" counter and a
 *     resolver queue: see `whenIdle()`.
 *   • The `lastOutputAt` timestamp updates on every chunk, so the
 *     idle-detector (wait_for_idle) can block until output stops.
 *   • On kill / exit the underlying PTY is fully torn down and the
 *     xterm emulator is disposed so there are no dangling listeners.
 */

import {
    spawn as ptySpawn,
    type IPty,
} from '@homebridge/node-pty-prebuilt-multiarch';
import xtermMod from '@xterm/headless';
import type { Terminal as XtermTerminal } from '@xterm/headless';

import { encodeKey, encodeKeys, encodeText } from '../keys/encoder.js';
import { parseKey } from '../keys/parser.js';
import type { KeyInput } from '../keys/types.js';
import type {
    SessionInfo,
    SessionState,
    StartSessionOptions,
} from './types.js';
import { VisibleViewer } from './viewer.js';

// @xterm/headless is CJS-shipped; the Terminal class lives on the default
// export.  Extract it once.
const { Terminal } = (xtermMod as { Terminal: typeof XtermTerminal });

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_TERM = 'xterm-256color';
const DEFAULT_OUTPUT_BUFFER_BYTES = 1 * 1024 * 1024; // 1 MB

let sessionIdCounter = 0;
function nextSessionId(): string {
    sessionIdCounter += 1;
    return `tui-${Date.now().toString(36)}-${sessionIdCounter}`;
}

/**
 * Ring buffer of raw PTY output.  We store decoded strings (each chunk
 * is UTF-8 from node-pty), concatenate on demand.  Trims the head when
 * total size exceeds `limit`.
 */
class RawOutputBuffer {
    private readonly limit: number;
    private chunks: string[] = [];
    private total = 0;
    private totalEver = 0;

    constructor(limit: number) {
        this.limit = limit;
    }

    append(chunk: string): void {
        this.chunks.push(chunk);
        this.total += chunk.length;
        this.totalEver += chunk.length;
        while (this.total > this.limit && this.chunks.length > 1) {
            const oldest = this.chunks.shift()!;
            this.total -= oldest.length;
        }
        // If a single chunk exceeds the limit, we still keep it — we
        // never drop the most recent bytes.
    }

    /** All currently-held bytes. */
    read(): string {
        return this.chunks.join('');
    }

    /** Tail of at most `bytes` bytes (approx by char count). */
    readTail(bytes: number): string {
        const whole = this.read();
        if (whole.length <= bytes) return whole;
        return whole.slice(whole.length - bytes);
    }

    bytesOut(): number {
        return this.totalEver;
    }
}

/**
 * A single live terminal session.
 */
export class TerminalSession {
    readonly id: string;
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly startedAt: number;

    private readonly pty: IPty;
    /** xterm emulator with `allowProposedApi` so we can read buffer lines. */
    readonly terminal: XtermTerminal;
    private readonly outputBuffer: RawOutputBuffer;

    private _state: SessionState = 'starting';
    private _cols: number;
    private _rows: number;
    private _exitedAt: number | null = null;
    private _exitCode: number | null = null;
    private _signal: string | null = null;
    private _lastOutputAt: number = Date.now();
    private viewer: VisibleViewer | null = null;

    /** Promises pending from `whenIdle()`. */
    private idleWaiters: Array<() => void> = [];
    /** Count of in-flight `terminal.write()` callbacks. */
    private pendingWrites = 0;

    /** Listeners for exit events — fired once. */
    private exitListeners: Array<(info: { code: number | null; signal: string | null }) => void> = [];
    /** Listeners for output chunks (used by e.g. monitor). */
    private outputListeners: Array<(chunk: string) => void> = [];

    private constructor(opts: StartSessionOptions) {
        this.id = nextSessionId();
        this.name = opts.name || this.id;
        this.command = opts.command;
        this.args = Object.freeze([...(opts.args ?? [])]);
        this.cwd = opts.cwd ?? process.cwd();
        this.startedAt = Date.now();
        this._cols = opts.cols ?? DEFAULT_COLS;
        this._rows = opts.rows ?? DEFAULT_ROWS;

        this.outputBuffer = new RawOutputBuffer(
            opts.outputBufferBytes ?? DEFAULT_OUTPUT_BUFFER_BYTES,
        );

        const env = resolveEnv(opts.env, opts.term ?? DEFAULT_TERM);

        // Spawn the PTY.  This can throw if the binary can't be found;
        // the caller (SessionManager) catches it and surfaces a tidy
        // error.
        this.pty = ptySpawn(this.command, [...this.args], {
            name: opts.term ?? DEFAULT_TERM,
            cols: this._cols,
            rows: this._rows,
            cwd: this.cwd,
            env,
        });

        this.terminal = new Terminal({
            cols: this._cols,
            rows: this._rows,
            allowProposedApi: true, // required to call buffer.active.getLine
        });

        // Optional visible mirror — spawns a new OS terminal window
        // running `cat <fifo>` so a human can watch the session live.
        if (opts.visible) {
            try {
                const v = new VisibleViewer(this.id, {
                    title: `tui-tester: ${this.name}`,
                });
                v.start(opts.viewerCommand);
                v.annotate(`Session ${this.id} started — ${this.command} ${this.args.join(' ')}`);
                this.viewer = v;
            } catch (err) {
                // Don't fail the whole session because we couldn't spawn
                // a GUI terminal — headless environments (CI, SSH, etc.)
                // may just not have one available.  The session still
                // works normally; the visible-mirror feature is silently
                // unavailable.
                this.viewer = null;
                process.stderr.write(
                    `[tui-tester] visible viewer failed to start: ${
                        err instanceof Error ? err.message : String(err)
                    }\n`,
                );
            }
        }

        this.pty.onData((data) => {
            this._state = this._state === 'starting' ? 'running' : this._state;
            this._lastOutputAt = Date.now();
            this.outputBuffer.append(data);
            // Tee into the viewer window first — that way the human's
            // view is as close to real-time as the kernel pipe buffer
            // allows.
            if (this.viewer) this.viewer.write(data);
            for (const listener of this.outputListeners) {
                try { listener(data); } catch { /* listener errors swallowed */ }
            }
            this.pendingWrites += 1;
            this.terminal.write(data, () => {
                this.pendingWrites -= 1;
                if (this.pendingWrites === 0) {
                    // Drain waiters atomically.
                    const waiters = this.idleWaiters;
                    this.idleWaiters = [];
                    for (const w of waiters) {
                        try { w(); } catch { /* swallowed */ }
                    }
                }
            });
        });

        this.pty.onExit(({ exitCode, signal }) => {
            this._state = this._state === 'killed' ? 'killed' : 'exited';
            this._exitedAt = Date.now();
            this._exitCode = typeof exitCode === 'number' ? exitCode : null;
            this._signal = typeof signal === 'number'
                ? `signal-${signal}`
                : (signal ?? null);
            // Drain any remaining idle waiters so callers don't hang.
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const w of waiters) {
                try { w(); } catch { /* swallowed */ }
            }
            const listeners = this.exitListeners;
            this.exitListeners = [];
            for (const l of listeners) {
                try { l({ code: this._exitCode, signal: this._signal }); } catch { /* swallowed */ }
            }
        });
    }

    /**
     * Factory — spawns the PTY and returns a ready session.  Throws if
     * the executable can't be spawned.
     */
    static start(opts: StartSessionOptions): TerminalSession {
        if (!opts.command || typeof opts.command !== 'string') {
            throw new Error('start: `command` is required');
        }
        return new TerminalSession(opts);
    }

    /** Current session summary. */
    info(): SessionInfo {
        return {
            id: this.id,
            name: this.name,
            command: this.command,
            args: [...this.args],
            cwd: this.cwd,
            state: this._state,
            cols: this._cols,
            rows: this._rows,
            pid: this.pty.pid ?? null,
            startedAt: this.startedAt,
            exitedAt: this._exitedAt,
            exitCode: this._exitCode,
            signal: this._signal,
            bytesOut: this.outputBuffer.bytesOut(),
            visible: this.viewer !== null,
            viewerFifo: this.viewer?.fifoPath ?? null,
        };
    }

    /** Push a human-readable annotation into the viewer window (no-op if no viewer). */
    annotateViewer(line: string): void {
        this.viewer?.annotate(line);
    }

    /** True iff the process has not exited or been killed yet. */
    isAlive(): boolean {
        return this._state === 'starting' || this._state === 'running';
    }

    get cols(): number { return this._cols; }
    get rows(): number { return this._rows; }
    get state(): SessionState { return this._state; }
    get lastOutputAt(): number { return this._lastOutputAt; }
    get exitCode(): number | null { return this._exitCode; }
    get signal(): string | null { return this._signal; }

    // ── Input ───────────────────────────────────────────────────────

    /** Send raw bytes to the PTY's stdin. */
    writeRaw(bytes: string): void {
        if (!this.isAlive()) {
            throw new Error(`Session ${this.id} is not running (state=${this._state})`);
        }
        this.pty.write(bytes);
    }

    /** Send plain text (passes through). */
    sendText(text: string): void {
        this.writeRaw(encodeText(text));
    }

    /** Send a single key (string like "ctrl+c" or a KeySpec). */
    sendKey(key: KeyInput): void {
        this.writeRaw(encodeKey(parseKey(key)));
    }

    /** Send an ordered list of keys. */
    sendKeys(keys: KeyInput[]): void {
        this.writeRaw(encodeKeys(keys.map(parseKey)));
    }

    // ── Output / idle / state ──────────────────────────────────────

    /**
     * Resolve once every pending `terminal.write()` callback has fired
     * (the xterm parser is caught up).  If the terminal is already idle
     * resolves on the next microtask.
     */
    async whenParserFlushed(): Promise<void> {
        if (this.pendingWrites === 0) return;
        await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }

    /** Raw output bytes held in the ring buffer. */
    rawOutput(): string {
        return this.outputBuffer.read();
    }

    /** Last N bytes of output. */
    rawOutputTail(maxBytes: number): string {
        return this.outputBuffer.readTail(maxBytes);
    }

    /** Register a listener for every raw output chunk.  Returns a disposer. */
    onOutput(listener: (chunk: string) => void): () => void {
        this.outputListeners.push(listener);
        return () => {
            const idx = this.outputListeners.indexOf(listener);
            if (idx >= 0) this.outputListeners.splice(idx, 1);
        };
    }

    /** Register a listener for process exit.  Returns a disposer. */
    onExit(listener: (info: { code: number | null; signal: string | null }) => void): () => void {
        // If already exited, fire asynchronously so the caller can
        // register first.
        if (!this.isAlive()) {
            queueMicrotask(() =>
                listener({ code: this._exitCode, signal: this._signal }),
            );
            return () => { /* no-op */ };
        }
        this.exitListeners.push(listener);
        return () => {
            const idx = this.exitListeners.indexOf(listener);
            if (idx >= 0) this.exitListeners.splice(idx, 1);
        };
    }

    // ── Control ────────────────────────────────────────────────────

    /**
     * Change the terminal dimensions.  Forwards to both the PTY (so the
     * child sees a SIGWINCH) and the xterm emulator (so the cell grid
     * layout matches).
     */
    resize(cols: number, rows: number): void {
        if (cols <= 0 || rows <= 0) {
            throw new Error(`resize: cols and rows must be positive (got ${cols}x${rows})`);
        }
        const c = Math.floor(cols);
        const r = Math.floor(rows);
        this._cols = c;
        this._rows = r;
        if (this.isAlive()) {
            try { this.pty.resize(c, r); } catch { /* PTY may have died between checks */ }
        }
        this.terminal.resize(c, r);
    }

    /**
     * Send a signal / kill the process.  Default SIGTERM.  The actual
     * exit event is reported asynchronously via `onExit`.
     */
    async stop(signal: NodeJS.Signals = 'SIGTERM', timeoutMs = 2000): Promise<void> {
        if (!this.isAlive()) {
            // Already dead — still make sure viewer is torn down.
            this.viewer?.stop();
            this.viewer = null;
            return;
        }
        this._state = 'killed';
        // Write a final annotation so the watcher knows the session ended.
        this.viewer?.annotate(`Session stopping (${signal})`);
        try { this.pty.kill(signal); } catch { /* process may already be gone */ }
        // Escalate to SIGKILL if the process doesn't exit within the timeout.
        await new Promise<void>((resolve) => {
            let done = false;
            const disposer = this.onExit(() => {
                if (done) return;
                done = true;
                resolve();
            });
            setTimeout(() => {
                if (done) return;
                try { this.pty.kill('SIGKILL'); } catch { /* ignore */ }
                setTimeout(() => {
                    if (done) return;
                    done = true;
                    disposer();
                    resolve();
                }, Math.max(100, Math.floor(timeoutMs / 4)));
            }, timeoutMs);
        });
        try { this.terminal.dispose(); } catch { /* already disposed */ }
        // Final viewer teardown — also unlinks the FIFO.
        if (this.viewer) {
            this.viewer.annotate('Session ended');
            this.viewer.stop();
            this.viewer = null;
        }
    }
}

/**
 * Build the environment for the child process.
 *   • `env = null` → start from an empty env (rare)
 *   • `env = {…}`  → merged onto process.env (user values win)
 *   • `env` omitted → a copy of process.env
 * In every case we set / override TERM to what the caller asked for.
 */
function resolveEnv(
    userEnv: Record<string, string> | null | undefined,
    term: string,
): Record<string, string> {
    let base: Record<string, string>;
    if (userEnv === null) {
        base = {};
    } else {
        base = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (typeof v === 'string') base[k] = v;
        }
        if (userEnv) {
            for (const [k, v] of Object.entries(userEnv)) {
                base[k] = v;
            }
        }
    }
    base.TERM = term;
    // Many TUIs behave better with a predictable LANG.
    if (!base.LANG) base.LANG = 'en_US.UTF-8';
    return base;
}
