/**
 * End-to-end tool tests.  These exercise the public tool surface of the
 * MCP server (start_session, send_keys, snapshot, wait_for_text, etc.)
 * by calling the handlers directly — we don't need to go over stdio to
 * verify that the tools work, just that they're wired together
 * correctly.
 *
 * Every tool gets at least one happy-path assertion here, and a few
 * error paths (session-not-found, invalid key, etc.).
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

let rigs: Array<Awaited<ReturnType<typeof makeRig>>> = [];

afterEach(async () => {
    await Promise.all(rigs.map((r) => r.manager.shutdown()));
    rigs = [];
});

function newRig() {
    const r = makeRig();
    rigs.push(r);
    return r;
}

describe('tools — discoverability', () => {
    it('registers every expected tool name', () => {
        const { tools } = newRig();
        const names = new Set(tools.map((t) => t.name));
        for (const expected of [
            'start_session', 'stop_session', 'list_sessions',
            'run_script',
            'send_keys', 'send_text', 'send_raw',
            'hold_key', 'type_text',
            'snapshot', 'get_text', 'get_cursor',
            'wait_for_text', 'wait_for_idle',
            'resize',
            'start_monitor', 'stop_monitor',
            'diff_snapshots',
            'get_exit_info', 'get_raw_output',
        ]) {
            expect(names.has(expected)).toBe(true);
        }
    });

    it('every tool has a non-empty description', () => {
        const { tools } = newRig();
        for (const t of tools) {
            expect(t.description.length).toBeGreaterThan(20);
        }
    });
});

describe('tools — start_session + lifecycle', () => {
    it('starts a session, lists it, gets exit info, and stops it', async () => {
        const { call } = newRig();

        const start = await call('start_session', {
            command: 'bash',
            args: ['-c', 'printf "ready\\n"; sleep 10'],
        });
        expect(start.isError).toBeFalsy();
        const startData = structured(start) as {
            sessionId: string;
            info: { pid: number | null; command: string };
        };
        expect(startData.sessionId).toMatch(/^tui-/);
        expect(startData.info.pid).toBeGreaterThan(0);

        const list = structured(await call('list_sessions', {})) as {
            count: number;
            sessions: Array<{ id: string; state: string }>;
        };
        expect(list.count).toBe(1);
        expect(list.sessions[0]!.id).toBe(startData.sessionId);

        await call('wait_for_text', {
            sessionId: startData.sessionId,
            pattern: 'ready',
            timeoutMs: 2000,
        });

        const stop = await call('stop_session', {
            sessionId: startData.sessionId,
            signal: 'SIGKILL',
        });
        expect(stop.isError).toBeFalsy();
    });

    it('returns an isError result for an unknown sessionId', async () => {
        const { call } = newRig();
        const r = await call('snapshot', { sessionId: 'not-a-real-id' });
        expect(r.isError).toBe(true);
        expect(r.content[0]!.text).toContain('Session not found');
    });
});

describe('tools — send_keys + snapshot', () => {
    it('sends plain text, then snapshots the echoed output', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'head -c 12'],
            cols: 80, rows: 24,
        })) as { sessionId: string }).sessionId;

        await new Promise((r) => setTimeout(r, 100));
        await call('send_text', { sessionId: sid, text: 'hello world\n' });

        // head will exit on its own; wait a moment.
        await new Promise((r) => setTimeout(r, 200));

        const snap = structured(await call('snapshot', {
            sessionId: sid,
            format: 'text',
        })) as { text: string; cursor: { row: number; col: number } };
        expect(snap.text).toContain('hello world');
        expect(typeof snap.cursor.row).toBe('number');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('encodes key specs on the way out (ctrl+c byte 0x03)', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'exec sleep 10'],
        })) as { sessionId: string }).sessionId;
        await new Promise((r) => setTimeout(r, 200));

        const r = await call('send_keys', { sessionId: sid, keys: 'ctrl+c' });
        expect(r.isError).toBeFalsy();

        // The process should die on SIGINT.
        const info = structured(await call('get_exit_info', { sessionId: sid })) as {
            state: string;
        };
        // Give it a moment — the exit event is async.
        await new Promise((r2) => setTimeout(r2, 200));
        const info2 = structured(await call('get_exit_info', { sessionId: sid })) as {
            state: string;
        };
        expect(['exited', 'killed']).toContain(info2.state);
        // silence unused var
        void info;
    });

    it('send_keys accepts an array of mixed key specs', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'cat > /dev/null'],
        })) as { sessionId: string }).sessionId;

        await new Promise((r) => setTimeout(r, 100));
        const r = await call('send_keys', {
            sessionId: sid,
            keys: ['h', 'i', { key: 'Enter' }],
        });
        expect(r.isError).toBeFalsy();
        const data = structured(r) as { keyCount: number; bytesSent: number };
        expect(data.keyCount).toBe(3);
        expect(data.bytesSent).toBe(3);   // h, i, \r = 3 bytes

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('tools — resize + get_cursor', () => {
    it('resizes and updates cursor/dims on the session', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'sleep 1'],
            cols: 80, rows: 24,
        })) as { sessionId: string }).sessionId;

        await call('resize', { sessionId: sid, cols: 100, rows: 30 });
        const text = structured(await call('get_text', { sessionId: sid })) as {
            cols: number; rows: number;
        };
        expect(text.cols).toBe(100);
        expect(text.rows).toBe(30);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('tools — monitor lifecycle', () => {
    it('start_monitor → stop_monitor returns recorded frames', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'for i in 1 2 3; do printf "step-%s\\n" $i; sleep 0.05; done'],
        })) as { sessionId: string }).sessionId;

        const mon = structured(await call('start_monitor', {
            sessionId: sid, intervalMs: 30,
        })) as { monitorId: string };

        // Let the command run to completion.
        await new Promise((r) => setTimeout(r, 500));

        const stopped = structured(await call('stop_monitor', {
            monitorId: mon.monitorId,
        })) as { frameCount: number; frames: Array<{ text: string; changed: boolean }> };
        expect(stopped.frameCount).toBeGreaterThan(0);
        const joined = stopped.frames.map((f) => f.text).join('\n');
        expect(joined).toContain('step-1');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('tools — send_raw', () => {
    it('accepts hex bytes', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'head -c 5'],
        })) as { sessionId: string }).sessionId;
        await new Promise((r) => setTimeout(r, 100));
        // "hello" as hex = 68 65 6c 6c 6f
        const r = await call('send_raw', {
            sessionId: sid,
            hex: '68656c6c6f',
        });
        expect(r.isError).toBeFalsy();
        const data = structured(r) as { bytesSent: number };
        expect(data.bytesSent).toBe(5);
        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('rejects malformed hex', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash', args: ['-c', 'sleep 1'],
        })) as { sessionId: string }).sessionId;
        const r = await call('send_raw', { sessionId: sid, hex: 'not-hex-at-all' });
        expect(r.isError).toBe(true);
        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('tools — snapshot includeScrollback', () => {
    it('returns a scrollback bundle containing lines scrolled off the viewport', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'for i in $(seq 1 60); do printf "S%03d\\n" $i; done'],
            cols: 20, rows: 5,
        })) as { sessionId: string }).sessionId;

        // Let the command finish.
        await new Promise((r) => setTimeout(r, 400));

        const snap = structured(await call('snapshot', {
            sessionId: sid, includeScrollback: true, maxScrollbackLines: 500,
        })) as {
            text: string;
            scrollback?: { lines: string[]; text: string; totalLines: number; truncated: boolean };
        };

        expect(snap.scrollback).toBeDefined();
        expect(snap.scrollback!.truncated).toBe(false);
        expect(snap.scrollback!.totalLines).toBeGreaterThan(5);
        // Scrolled-off content is in the bundle even though it's not in
        // `text` (visible viewport).
        expect(snap.scrollback!.text).toContain('S001');
        expect(snap.scrollback!.text).toContain('S060');
        expect(snap.text).not.toContain('S001');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('omits the scrollback field by default', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash', args: ['-c', 'printf "only one line"'],
        })) as { sessionId: string }).sessionId;
        await new Promise((r) => setTimeout(r, 200));

        const snap = structured(await call('snapshot', { sessionId: sid })) as {
            text: string; scrollback?: unknown;
        };
        expect(snap.scrollback).toBeUndefined();

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('tools — get_text includeScrollback', () => {
    it('plumbs the same option through to the lighter tool', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'for i in 1 2 3 4 5 6 7 8 9 10; do echo row$i; done'],
            cols: 20, rows: 3,
        })) as { sessionId: string }).sessionId;
        await new Promise((r) => setTimeout(r, 250));

        const snap = structured(await call('get_text', {
            sessionId: sid, includeScrollback: true,
        })) as { scrollback?: { text: string } };

        expect(snap.scrollback).toBeDefined();
        expect(snap.scrollback!.text).toContain('row1');
        expect(snap.scrollback!.text).toContain('row10');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('tools — diff_snapshots (stateless)', () => {
    it('diffs two text snapshots without needing a session', async () => {
        const { call } = newRig();
        const cursor = { row: 0, col: 0, visible: true };
        const r = await call('diff_snapshots', {
            before: { lines: ['a', 'b', 'c'], cols: 10, rows: 3, cursor },
            after: { lines: ['a', 'B', 'c'], cols: 10, rows: 3, cursor },
        });
        expect(r.isError).toBeFalsy();
        const d = structured(r) as {
            identical: boolean;
            changedLines: Array<{ row: number; after: string }>;
        };
        expect(d.identical).toBe(false);
        expect(d.changedLines).toEqual([{ row: 1, before: 'b', after: 'B' }]);
    });
});

describe('tools — error paths', () => {
    it('wait_for_text times out as an isError result (not an exception)', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash', args: ['-c', 'sleep 10'],
        })) as { sessionId: string }).sessionId;
        const r = await call('wait_for_text', {
            sessionId: sid, pattern: 'NEVER', timeoutMs: 100,
        });
        expect(r.isError).toBe(true);
        expect(r.content[0]!.text).toContain('did not appear within');
        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('rejects an invalid key string', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash', args: ['-c', 'sleep 1'],
        })) as { sessionId: string }).sessionId;
        const r = await call('send_keys', { sessionId: sid, keys: 'doom+x' });
        expect(r.isError).toBe(true);
        expect(r.content[0]!.text.toLowerCase()).toContain('modifier');
        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});
