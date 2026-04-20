import { afterEach, describe, expect, it } from '@jest/globals';
import { TerminalSession } from '../../src/session/terminal-session.js';
import { Monitor } from '../../src/monitor/monitor.js';

let open: TerminalSession[] = [];

afterEach(async () => {
    await Promise.all(open.map((s) => s.stop('SIGKILL').catch(() => { /* ignore */ })));
    open = [];
});

function track(s: TerminalSession): TerminalSession {
    open.push(s);
    return s;
}

describe('Monitor — frame-level recording', () => {
    it('records every change when a command streams multiple lines', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'for i in 1 2 3 4 5; do printf "line-%s\\n" $i; sleep 0.05; done'],
            cols: 80,
            rows: 24,
        }));
        const mon = new Monitor(s, { intervalMs: 30 });
        mon.start();

        // Wait for the command to finish.
        await new Promise<void>((r) => s.onExit(() => r()));
        await s.whenParserFlushed();

        const result = mon.stop();
        expect(result.frameCount).toBeGreaterThanOrEqual(2);
        // Every recorded frame (by default keepIdenticalFrames=false) should
        // be flagged as changed.
        for (const frame of result.frames) {
            expect(frame.changed).toBe(true);
        }
        // The final frame should show all 5 lines.
        const last = result.frames[result.frames.length - 1]!;
        expect(last.text).toContain('line-5');
    });

    it('respects keepIdenticalFrames=true and records quiet frames too', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'printf "only once\\n"; sleep 0.3'],
            cols: 80,
            rows: 24,
        }));
        const mon = new Monitor(s, { intervalMs: 30, keepIdenticalFrames: true });
        mon.start();
        await new Promise<void>((r) => s.onExit(() => r()));
        await s.whenParserFlushed();
        const result = mon.stop();
        // Many idle frames should have accumulated.
        expect(result.frameCount).toBeGreaterThan(result.changedFrameCount);
    });

    it('honours the maxFrames cap and marks truncated=true', async () => {
        const s = track(TerminalSession.start({
            command: 'bash',
            args: ['-c', 'for i in $(seq 1 50); do printf "tick %s\\n" $i; sleep 0.02; done'],
            cols: 80,
            rows: 24,
        }));
        const mon = new Monitor(s, { intervalMs: 10, maxFrames: 5, keepIdenticalFrames: true });
        mon.start();
        await new Promise<void>((r) => s.onExit(() => r()));
        const result = mon.stop();
        expect(result.frameCount).toBeLessThanOrEqual(5);
        expect(result.truncated).toBe(true);
    });
});
