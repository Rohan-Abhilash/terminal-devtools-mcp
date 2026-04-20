import { afterEach, describe, expect, it } from '@jest/globals';
import { TerminalSession } from '../../src/session/terminal-session.js';
import { buildSnapshot } from '../../src/snapshot/snapshot.js';
import { waitForText, waitForIdle, holdKey, typeText } from '../../src/session/wait.js';

/**
 * These tests exercise the real PTY + xterm pipeline end-to-end.  They
 * spawn `bash` (or `cat`) and observe the emulator state.  They're
 * relatively quick (~100–500ms each) because the child commands exit
 * immediately.
 */

let openSessions: TerminalSession[] = [];

afterEach(async () => {
    await Promise.all(openSessions.map((s) => s.stop('SIGKILL').catch(() => { /* ignore */ })));
    openSessions = [];
});

function track(s: TerminalSession): TerminalSession {
    openSessions.push(s);
    return s;
}

describe('TerminalSession — basic lifecycle', () => {
    it('spawns bash, echoes a line, and exits cleanly', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'printf "hello from bash\\n"'],
            cols: 80,
            rows: 24,
        }));

        await new Promise<void>((resolve) => {
            s.onExit(() => resolve());
        });
        await s.whenParserFlushed();

        const snap = buildSnapshot(s.terminal, 'text');
        expect(snap.lines[0]).toBe('hello from bash');
        expect(s.state).toBe('exited');
        expect(s.exitCode).toBe(0);
    });

    it('reports the correct pid and initial info', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'sleep 0.2'],
        }));
        const info = s.info();
        expect(info.command).toBe('bash');
        expect(info.pid).toBeGreaterThan(0);
        expect(info.cols).toBe(120);
        expect(info.rows).toBe(40);
        expect(['starting', 'running']).toContain(info.state);

        await new Promise<void>((r) => s.onExit(() => r()));
        expect(s.info().state).toBe('exited');
    });
});

describe('TerminalSession — input', () => {
    it('sends plain text through sendText and the child sees it', async () => {
        // `head -c N` reads up to N bytes then exits — simpler than `cat`
        // which has line-buffering / EOF subtleties.
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'head -c 6'],
            cols: 80,
            rows: 24,
        }));
        await new Promise((r) => setTimeout(r, 100));
        s.sendText('hello\n');
        await new Promise<void>((r) => {
            const timeout = setTimeout(() => r(), 2000);
            s.onExit(() => { clearTimeout(timeout); r(); });
        });
        await s.whenParserFlushed();

        const snap = buildSnapshot(s.terminal, 'text');
        expect(snap.text).toContain('hello');
    });

    it('sends ctrl+c to interrupt a running process', async () => {
        // `sleep` alone (no chained command) responds directly to SIGINT —
        // bash-c'd sequences like "sleep 30; echo done" ignore SIGINT
        // after the interrupted command and exit 0, which would make the
        // test vacuous.  Using sleep directly via exec avoids bash's
        // intermediate "continue after SIGINT" behaviour.
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'exec sleep 30'],
        }));
        await new Promise((r) => setTimeout(r, 200));
        s.sendKey('ctrl+c');
        const exit = await new Promise<{ code: number | null; signal: string | null }>((r) => {
            s.onExit(r);
        });
        // Died via SIGINT — either a non-zero exit code (128+2 = 130) or
        // a signal was reported.
        const sig = exit.signal ?? '';
        const killed = sig.length > 0 || (exit.code !== null && exit.code !== 0);
        expect(killed).toBe(true);
        expect(s.isAlive()).toBe(false);
    });
});

describe('TerminalSession — resize', () => {
    it('updates the emulator cols/rows on resize()', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'sleep 0.5'],
            cols: 80, rows: 24,
        }));
        expect(s.cols).toBe(80);
        expect(s.rows).toBe(24);
        s.resize(100, 30);
        expect(s.cols).toBe(100);
        expect(s.rows).toBe(30);
        expect(s.terminal.cols).toBe(100);
        expect(s.terminal.rows).toBe(30);
        await new Promise<void>((r) => s.onExit(() => r()));
    });
});

describe('TerminalSession — wait helpers', () => {
    it('waitForText resolves when the pattern appears', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'sleep 0.1; printf "LOADED\\n"; sleep 0.5'],
        }));
        const result = await waitForText(s, {
            pattern: 'LOADED',
            timeoutMs: 2000,
        });
        expect(result.matched).toBe(true);
        expect(result.match).toBe('LOADED');
        expect(result.elapsedMs).toBeLessThan(2000);
    });

    it('waitForText rejects on timeout', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'sleep 1'],
        }));
        await expect(waitForText(s, {
            pattern: 'NEVER',
            timeoutMs: 200,
        })).rejects.toThrow(/did not appear within/);
    });

    it('waitForText with regex', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'printf "ready_42\\n"'],
        }));
        const result = await waitForText(s, {
            pattern: /^ready_(\d+)/m,
            timeoutMs: 2000,
        });
        expect(result.matched).toBe(true);
        const m = result.match as RegExpMatchArray;
        expect(m[1]).toBe('42');
    });

    it('waitForIdle resolves once the terminal stops writing', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'printf "A\\n"; sleep 0.1; printf "B\\n"'],
        }));
        const result = await waitForIdle(s, {
            idleMs: 200,
            timeoutMs: 2000,
        });
        expect(result.idleFor).toBeGreaterThanOrEqual(200);
    });
});

describe('TerminalSession — holdKey & typeText', () => {
    it('holdKey fires multiple events at roughly the configured interval', async () => {
        // Use `head -c N` — a program that reads up to N bytes and exits
        // cleanly.  Simpler than `cat` which has ctrl+d / newline
        // buffering caveats.
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'head -c 1000 > /dev/null'],
        }));
        await new Promise((r) => setTimeout(r, 100));
        const { events } = await holdKey(s, 'x', { durationMs: 200, intervalMs: 30 });
        // 200 ms / 30 ms ≈ 6-7 events + the initial fire = 7-8 total.
        // Accept a wide range to avoid flakiness on busy CI machines.
        expect(events).toBeGreaterThanOrEqual(3);
        expect(events).toBeLessThanOrEqual(20);
        // head exits once it hits 1000 bytes; we'll never reach that in
        // 200ms so the afterEach cleanup will SIGKILL it.
    });

    it('typeText writes every character in order', async () => {
        // head -c 32 will consume ~32 bytes then exit, echoing to stdout.
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'head -c 20'],
        }));
        await new Promise((r) => setTimeout(r, 100));
        await typeText(s, 'hello world exit 12', { cps: 200 });
        // head will now exit on its own having read 20 bytes.
        await new Promise<void>((r) => {
            const timeout = setTimeout(() => r(), 1000);
            s.onExit(() => { clearTimeout(timeout); r(); });
        });
        await s.whenParserFlushed();

        const snap = buildSnapshot(s.terminal, 'text');
        // The PTY echoes stdin back to stdout, and head also prints what
        // it read.  Either way "hello world" should appear on screen.
        expect(snap.text).toContain('hello world');
    });
});
