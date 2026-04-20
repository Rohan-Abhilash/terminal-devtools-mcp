/**
 * Public types for the session layer.
 */

/** Options passed to `SessionManager.start(…)`. */
export interface StartSessionOptions {
    /** Executable to spawn (e.g. "bash", "node", "./my-cli"). */
    command: string;
    /** Arguments to the executable. */
    args?: string[];
    /** Working directory.  Defaults to the MCP server's CWD. */
    cwd?: string;
    /**
     * Environment variables.  Merged onto the server's own env; values
     * provided here take precedence.  Set to `null` to start from an
     * empty env (rarely useful).
     */
    env?: Record<string, string> | null;
    /** Terminal columns.  Default 120. */
    cols?: number;
    /** Terminal rows.  Default 40. */
    rows?: number;
    /**
     * TERM value.  Default "xterm-256color" — matches what most TUIs
     * expect and what @xterm/headless faithfully emulates.
     */
    term?: string;
    /**
     * Friendly name for the session — shown in `list_sessions` output.
     * If omitted the session id is used.
     */
    name?: string;
    /**
     * How many raw-output bytes to retain for replay / debugging.
     * Default 1 MB — old bytes are trimmed from the head when exceeded.
     */
    outputBufferBytes?: number;
    /**
     * If true, open a visible OS terminal window that mirrors every
     * byte the PTY emits so a human can watch the model test the TUI
     * live.  Implemented via a FIFO + `cat` on macOS/Linux; silently
     * no-op on unsupported platforms (Windows for now).  Default false.
     */
    visible?: boolean;
    /**
     * Optional override for the viewer spawn command (platform-default
     * used when omitted).  Only used when `visible` is true.
     * `args` may contain `{fifo}` and `{title}` placeholders.
     */
    viewerCommand?: {
        command: string;
        args: string[];
    };
}

/** Lifecycle state of a session. */
export type SessionState =
    | 'starting'   // spawn() succeeded, first byte of output not yet received
    | 'running'    // producing output and accepting input
    | 'exited'     // process exited; terminal buffer still readable
    | 'killed'     // terminated by MCP (stop_session or shutdown)
    | 'error';     // failed to spawn at all

/** Summary of a session — what `list_sessions` returns per session. */
export interface SessionInfo {
    id: string;
    name: string;
    command: string;
    args: string[];
    cwd: string;
    state: SessionState;
    cols: number;
    rows: number;
    pid: number | null;
    /** Unix ms when `start()` returned. */
    startedAt: number;
    /** Unix ms when the process exited, if it has. */
    exitedAt: number | null;
    /** Exit code (may be null on signal termination). */
    exitCode: number | null;
    /** Exit signal (e.g. "SIGTERM") if killed by signal. */
    signal: string | null;
    /** Total bytes of raw output produced so far. */
    bytesOut: number;
    /** Whether a visible viewer terminal is attached. */
    visible: boolean;
    /** FIFO path if a viewer is attached (for manual reconnect), else null. */
    viewerFifo: string | null;
}
