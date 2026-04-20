/**
 * VisibleViewer — mirrors a `TerminalSession`'s PTY output into a new
 * real terminal window so a human can watch the AI drive the TUI in
 * real time.
 *
 * Mechanism
 * ─────────
 *   1. Create a named pipe (FIFO) in the OS temp dir.
 *   2. Open it with O_RDWR | O_NONBLOCK from this process — lets us
 *      write into the pipe without blocking even when no reader has
 *      attached yet, and prevents EOF when a reader disconnects.
 *   3. Spawn a platform-specific terminal emulator ("Terminal.app" on
 *      macOS, `x-terminal-emulator` / `gnome-terminal` / `xterm` on
 *      Linux) whose single job is to run `cat <fifo>` — that lets the
 *      host terminal natively render every ANSI byte we send.
 *   4. Session.onData tees each chunk into the FIFO.  If the user
 *      closes the viewer, writes return EPIPE and we simply stop
 *      writing (session keeps running regardless).
 *
 * Why not pipe / socket?  A FIFO is the simplest abstraction that
 * (a) a plain `cat` can read with no extra code, (b) survives across
 * multiple viewer sessions (user can close and re-open the viewer),
 * and (c) has no TCP port / permission concerns.  Named sockets need
 * a custom reader; a regular file grows unboundedly.
 *
 * Supported platforms: macOS and Linux.  Windows is left out for now
 * (named pipes work differently there and would need a dedicated
 * viewer implementation).
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ViewerCommand {
    /** Executable to run (e.g. "osascript", "gnome-terminal"). */
    command: string;
    /**
     * Argument template.  Each element containing the literal string
     * `{fifo}` has it replaced with the FIFO path; `{title}` likewise
     * with the window title.
     */
    args: string[];
}

export interface VisibleViewerOptions {
    /** Friendly title shown in the viewer window. */
    title: string;
    /** Override the platform-default spawn command. */
    command?: ViewerCommand;
    /**
     * Where to put the FIFO file.  Defaults to the OS temp dir.
     */
    fifoDir?: string;
}

/**
 * Platform detection and default viewer command resolution.
 * Exported so the MCP tool handler can explain to callers whether
 * the feature will work on their host.
 */
export function defaultViewerCommand(): ViewerCommand | null {
    if (process.platform === 'darwin') {
        // AppleScript: open Terminal.app, set the window title, then run
        // `cat <fifo>`.  The embedded printf sets the OSC window-title
        // escape so users can tell sessions apart.
        //
        // We escape the title and path within the script to cope with
        // quotes.  Safe as long as the caller doesn't pass newlines in
        // title / fifo path — we control both.
        return {
            command: 'osascript',
            args: [
                '-e',
                'tell application "Terminal"\n' +
                '  activate\n' +
                '  do script "printf \\"\\\\033]0;{title}\\\\007\\"; cat \\"{fifo}\\""\n' +
                'end tell',
            ],
        };
    }
    if (process.platform === 'linux') {
        // Many distros expose `x-terminal-emulator` via the
        // update-alternatives system.  If not, we fall back through
        // common emulators at construction time.
        const candidates = [
            { bin: 'x-terminal-emulator', args: ['-T', '{title}', '-e', 'bash', '-c', 'cat "{fifo}"; read'] },
            { bin: 'gnome-terminal',      args: ['--title={title}', '--', 'bash', '-c', 'cat "{fifo}"; read'] },
            { bin: 'konsole',             args: ['-p', 'tabtitle={title}', '-e', 'bash', '-c', 'cat "{fifo}"; read'] },
            { bin: 'xterm',               args: ['-T', '{title}', '-e', 'bash', '-c', 'cat "{fifo}"; read'] },
        ];
        for (const { bin, args } of candidates) {
            try {
                execFileSync('which', [bin], { stdio: 'ignore' });
                return { command: bin, args };
            } catch { /* not found, try next */ }
        }
        return null;
    }
    // Windows + other platforms — unsupported for now.
    return null;
}

export class VisibleViewer {
    readonly sessionId: string;
    readonly title: string;
    readonly fifoPath: string;
    private fd: number | null = null;
    private child: ChildProcess | null = null;
    private stopped = false;
    /**
     * True after the first successful write.  We use it to suppress
     * the spam of EPIPE log lines when the user closes the viewer
     * mid-session: we swallow a handful, but after that we stop even
     * attempting to write until the session restarts.
     */
    private failureCount = 0;

    constructor(sessionId: string, opts: VisibleViewerOptions) {
        this.sessionId = sessionId;
        this.title = opts.title;
        const dir = opts.fifoDir ?? os.tmpdir();
        this.fifoPath = path.join(dir, `tui-tester-${sanitiseForPath(sessionId)}.fifo`);
    }

    /**
     * Create the FIFO, open the write-side fd, and spawn the viewer
     * terminal.  All synchronous — once start() returns the session
     * can safely call `write()`.  Throws if FIFO creation fails.
     */
    start(customCommand?: ViewerCommand): { spawned: boolean; command: ViewerCommand | null } {
        if (this.stopped) {
            throw new Error('VisibleViewer has been stopped — construct a new one');
        }
        const command = customCommand ?? defaultViewerCommand();

        // 1. Make sure we have a fresh FIFO — unlink any stale one.
        try { fs.unlinkSync(this.fifoPath); } catch { /* no-op */ }
        // `mkfifo` is in POSIX / available on macOS and Linux.
        execFileSync('mkfifo', [this.fifoPath]);

        // 2. Open O_RDWR | O_NONBLOCK so writes don't block even when
        //    the reader (`cat` in the viewer) hasn't started yet, and
        //    the kernel doesn't signal EOF when a reader later exits.
        //    We never actually *read* from this fd — we just hold the
        //    read side open to keep the pipe alive across viewer
        //    reconnects.
        const flags =
            (fs.constants.O_RDWR | fs.constants.O_NONBLOCK) as number;
        this.fd = fs.openSync(this.fifoPath, flags);

        // 3. Spawn the viewer terminal, if we know how on this host.
        if (command) {
            const args = command.args.map((arg) =>
                arg
                    .split('{fifo}').join(this.fifoPath)
                    .split('{title}').join(this.title),
            );
            try {
                this.child = spawn(command.command, args, {
                    // Detach so closing the MCP server doesn't force-kill
                    // the viewer window mid-read.
                    detached: true,
                    stdio: 'ignore',
                });
                this.child.unref();
                return { spawned: true, command };
            } catch {
                // Spawn failed — tear the FIFO down and fall through.
                this.closeFdAndUnlink();
                throw new Error(`Failed to spawn viewer terminal: ${command.command}`);
            }
        }
        // No command on this platform — still return OK.  Callers can
        // attach `cat <fifo>` manually from a terminal.
        return { spawned: false, command: null };
    }

    /**
     * Tee raw PTY bytes into the viewer.  Non-throwing:
     *   • EAGAIN  (pipe buffer momentarily full)  → drop this chunk
     *   • EPIPE   (reader went away mid-session)  → stop trying
     *   • other   → log once via a counter, keep the session alive
     */
    write(data: string): void {
        if (this.stopped || this.fd === null) return;
        if (this.failureCount > 16) return; // after too many failures, quit trying
        try {
            // Convert to Buffer so we can hand a byte count back to the
            // caller if useful.  node-pty gives us a utf-8 string.
            const buf = Buffer.from(data, 'utf-8');
            fs.writeSync(this.fd, buf);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'EAGAIN') {
                // Pipe buffer momentarily full; drop this chunk — the
                // TUI will be out of sync for the viewer but the real
                // xterm emulator was updated before us.
                return;
            }
            if (code === 'EPIPE') {
                // Reader (viewer terminal) went away.  Don't crash;
                // just stop trying to write.
                this.failureCount += 1;
                return;
            }
            this.failureCount += 1;
        }
    }

    /** Optional: write a human-readable annotation into the viewer. */
    annotate(line: string): void {
        if (this.stopped || this.fd === null) return;
        // Use a dim-grey inverse style so the annotation doesn't blend
        // with the TUI output.  \r makes sure we start at col 0 in case
        // the TUI left the cursor elsewhere.
        const formatted = `\r\x1b[90;2m── ${line} ──\x1b[0m\r\n`;
        this.write(formatted);
    }

    /**
     * Close the fd, remove the FIFO, and best-effort kill the viewer
     * if it's still our child.  Idempotent.
     */
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.closeFdAndUnlink();
        if (this.child) {
            try { this.child.kill(); } catch { /* already gone */ }
            this.child = null;
        }
    }

    private closeFdAndUnlink(): void {
        if (this.fd !== null) {
            try { fs.closeSync(this.fd); } catch { /* no-op */ }
            this.fd = null;
        }
        try { fs.unlinkSync(this.fifoPath); } catch { /* no-op */ }
    }
}

/**
 * Replace characters unsafe for a file path with `_` so a session id
 * can be dropped verbatim into the FIFO filename.  Our ids are
 * already alphanumeric + `-`, but be defensive.
 */
function sanitiseForPath(s: string): string {
    return s.replace(/[^\w.-]/g, '_');
}
