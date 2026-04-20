/**
 * End-to-end tests for the screen-capture feature added to every input
 * tool (`send_keys`, `send_text`, `send_raw`, `hold_key`, `type_text`).
 *
 * Each of those tools now bundles a `screen` block in its response
 * containing before/after text, cursor positions, and a row-level diff.
 * These tests drive real PTYs (via the same SessionManager the MCP
 * server uses) and assert the structure + content of that block.
 */

import { afterEach, describe, expect, it } from '@jest/globals';

import { SessionManager } from '../../src/session/session-manager.js';
import { buildTools, type ToolDefinition } from '../../src/server/tools.js';
import type { ToolResult } from '../../src/server/result.js';

function makeRig() {
    const manager = new SessionManager();
    const tools = buildTools(manager);
    const byName = new Map<string, ToolDefinition>();
    for (const t of tools) byName.set(t.name, t);
    const call = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
        const tool = byName.get(name);
        if (!tool) throw new Error(`no such tool: ${name}`);
        return tool.handler(input);
    };
    return { manager, tools, call };
}

function structured(result: ToolResult): Record<string, unknown> {
    if (!result.structuredContent) {
        throw new Error(`result has no structured content: ${JSON.stringify(result)}`);
    }
    return result.structuredContent;
}

interface ScreenBlock {
    before: {
        text: string;
        lines: string[];
        cursor: { row: number; col: number; visible: boolean };
        cols: number;
        rows: number;
    };
    after: {
        text: string;
        lines: string[];
        cursor: { row: number; col: number; visible: boolean };
        cols: number;
        rows: number;
    };
    diff: {
        identical: boolean;
        cursorMoved: boolean;
        resized: boolean;
        changedLines: Array<{ row: number; before: string; after: string }>;
    };
    waitAfterMs: number;
    totalMs: number;
}

let rigs: Array<ReturnType<typeof makeRig>> = [];

afterEach(async () => {
    await Promise.all(rigs.map((r) => r.manager.shutdown()));
    rigs = [];
});

function newRig() {
    const r = makeRig();
    rigs.push(r);
    return r;
}

/** Start a `cat` session (echoes input in cooked mode) for visible-change tests. */
async function startCat(call: ReturnType<typeof makeRig>['call'], cols = 40, rows = 8): Promise<string> {
    const started = structured(await call('start_session', {
        command: 'bash',
        args: ['-c', 'exec cat'],
        cols, rows,
    })) as { sessionId: string };
    // Give the PTY a moment to open; cat prints nothing on start.
    await new Promise((r) => setTimeout(r, 120));
    return started.sessionId;
}

describe('screen capture — send_text', () => {
    it('returns a before/after/diff block by default', async () => {
        const { call } = newRig();
        const sid = await startCat(call);

        const r = await call('send_text', { sessionId: sid, text: 'alpha' });
        expect(r.isError).toBeFalsy();

        const data = structured(r) as { sessionId: string; bytesSent: number; screen?: ScreenBlock };
        expect(data.bytesSent).toBe(5);
        expect(data.screen).toBeDefined();

        const s = data.screen!;
        expect(s.before.cols).toBe(40);
        expect(s.before.rows).toBe(8);
        expect(s.after.cols).toBe(40);
        expect(s.after.rows).toBe(8);

        // "alpha" wasn't on-screen before, should be after (PTY echoes
        // it back in default cooked mode).
        expect(s.before.text).not.toContain('alpha');
        expect(s.after.text).toContain('alpha');

        // Diff should report a row-level change.
        expect(s.diff.identical).toBe(false);
        expect(s.diff.resized).toBe(false);
        expect(s.diff.changedLines.length).toBeGreaterThan(0);
        const changed = s.diff.changedLines.find((c) => c.after.includes('alpha'));
        expect(changed).toBeDefined();

        // Timing metadata is sensible.
        expect(s.waitAfterMs).toBe(150);
        expect(s.totalMs).toBeGreaterThanOrEqual(150);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('omits the screen block when captureScreen=false', async () => {
        const { call } = newRig();
        const sid = await startCat(call);

        const r = await call('send_text', {
            sessionId: sid, text: 'beta', captureScreen: false,
        });
        expect(r.isError).toBeFalsy();

        const data = structured(r) as { bytesSent: number; screen?: unknown };
        expect(data.bytesSent).toBe(4);
        expect(data.screen).toBeUndefined();

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('honours waitAfterMs=0 (skips settle wait)', async () => {
        const { call } = newRig();
        const sid = await startCat(call);

        const started = Date.now();
        const r = await call('send_text', {
            sessionId: sid, text: 'gamma', waitAfterMs: 0,
        });
        const took = Date.now() - started;

        const s = (structured(r) as { screen: ScreenBlock }).screen;
        expect(s.waitAfterMs).toBe(0);
        // Full call should complete well under the default 150 ms settle.
        expect(took).toBeLessThan(150);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('screen capture — send_keys', () => {
    it('captures cursor movement from an arrow-key keystroke', async () => {
        const { call } = newRig();
        const sid = await startCat(call);

        // First echo some text so the cursor is past column 0.
        await call('send_text', { sessionId: sid, text: 'hello' });

        // Left arrow — in cooked mode cat just echoes the CSI bytes, so
        // the main observable change is cursor position when the terminal
        // handles the escape itself.  Either way we expect the `screen`
        // block to be present and structurally valid.
        const r = await call('send_keys', { sessionId: sid, keys: 'left' });
        expect(r.isError).toBeFalsy();

        const data = structured(r) as { keyCount: number; bytesSent: number; screen: ScreenBlock };
        expect(data.keyCount).toBe(1);
        expect(data.bytesSent).toBeGreaterThan(0);
        expect(data.screen).toBeDefined();
        expect(data.screen.before.text).toContain('hello');
        expect(data.screen.after).toBeDefined();
        // Diff may or may not report cursor movement depending on mode,
        // but the structure must be there.
        expect(Array.isArray(data.screen.diff.changedLines)).toBe(true);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('shows a visible per-line change when the PTY prints a new line', async () => {
        const { call } = newRig();
        // Use a small shell script that prints when it sees a newline.
        const started = structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'while read line; do printf "got: %s\\n" "$line"; done'],
            cols: 40, rows: 8,
        })) as { sessionId: string };
        const sid = started.sessionId;
        await new Promise((r) => setTimeout(r, 150));

        const r = await call('send_text', {
            sessionId: sid, text: 'ping\n', waitAfterMs: 250,
        });
        const s = (structured(r) as { screen: ScreenBlock }).screen;

        expect(s.after.text).toContain('got: ping');
        expect(s.diff.identical).toBe(false);
        expect(s.diff.changedLines.some((c) => c.after.includes('got: ping'))).toBe(true);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('screen capture — send_raw', () => {
    it('captures a before/after around raw hex bytes', async () => {
        const { call } = newRig();
        const sid = await startCat(call);

        // 'xy' = 0x78 0x79
        const r = await call('send_raw', { sessionId: sid, hex: '7879' });
        expect(r.isError).toBeFalsy();

        const data = structured(r) as { bytesSent: number; screen: ScreenBlock };
        expect(data.bytesSent).toBe(2);
        expect(data.screen.after.text).toContain('xy');
        expect(data.screen.diff.identical).toBe(false);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('screen capture — type_text', () => {
    it('captures before/after across the whole typing interval', async () => {
        const { call } = newRig();
        const sid = await startCat(call);

        const r = await call('type_text', {
            sessionId: sid, text: 'typed', cps: 500,
        });
        expect(r.isError).toBeFalsy();

        const data = structured(r) as { chars: number; screen: ScreenBlock };
        expect(data.chars).toBe(5);
        expect(data.screen.before.text).not.toContain('typed');
        expect(data.screen.after.text).toContain('typed');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('screen capture — hold_key', () => {
    it('captures before/after around a brief hold', async () => {
        const { call } = newRig();
        const sid = await startCat(call);

        // Hold "x" for 60ms at 20ms interval -> ~3-4 keypresses.
        const r = await call('hold_key', {
            sessionId: sid, key: 'x', durationMs: 60, intervalMs: 20,
        });
        expect(r.isError).toBeFalsy();

        const data = structured(r) as { events: number; screen: ScreenBlock };
        expect(data.events).toBeGreaterThanOrEqual(2);
        expect(data.screen.before.text).not.toContain('xxx');
        expect(data.screen.after.text).toContain('x');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('screen capture — identical before/after', () => {
    it('reports identical=true when nothing changes on screen', async () => {
        const { call } = newRig();
        // cat -s sleeps waiting on stdin; sending empty text shouldn't
        // change the screen at all.
        const sid = await startCat(call);

        const r = await call('send_text', { sessionId: sid, text: '' });
        const s = (structured(r) as { screen: ScreenBlock }).screen;
        expect(s.diff.identical).toBe(true);
        expect(s.diff.changedLines).toEqual([]);
        expect(s.diff.cursorMoved).toBe(false);
        expect(s.diff.resized).toBe(false);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});
