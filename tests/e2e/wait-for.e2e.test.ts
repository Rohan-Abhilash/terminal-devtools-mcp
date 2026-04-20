/**
 * End-to-end tests for the `waitFor` option that every input tool
 * accepts.
 *
 * `waitFor` lets an agent submit input and, in the same tool call,
 * block until a specific text appears on screen (or timeout) and
 * capture the screen at that exact moment.  This prevents missing
 * transient post-input states that would otherwise disappear between
 * the `send_*` response and a follow-up `wait_for_text` round-trip.
 *
 * These tests drive the tools exactly the way the MCP server does —
 * through `buildTools(manager)` — and exercise the wire shape clients
 * will see.
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

interface WaitForBlock {
    pattern: string;
    matched: boolean;
    match: string | string[] | null;
    elapsedMs: number;
    timedOut: boolean;
    timeoutMs: number;
    matchedAgainst: 'screen' | 'raw';
}

interface ScreenBlock {
    before: { text: string };
    after: { text: string };
    diff: { identical: boolean };
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

/**
 * Start a bash one-liner that delays a few hundred ms before emitting a
 * line, then drops into `cat`.  Used to prove `waitFor` actually blocks
 * until the delayed line appears.
 */
async function startDelayedEmitter(
    call: ReturnType<typeof makeRig>['call'],
    bashScript: string,
    cols = 60, rows = 10,
): Promise<string> {
    const started = structured(await call('start_session', {
        command: 'bash',
        args: ['-c', bashScript],
        cols, rows,
    })) as { sessionId: string };
    // Let the PTY open.
    await new Promise((r) => setTimeout(r, 120));
    return started.sessionId;
}

describe('send_text + waitFor', () => {
    it('blocks until the expected response appears after the input lands', async () => {
        const { call } = newRig();
        // A shell that, for every input line, waits 300 ms then prints
        // "got: <line>".  This guarantees the response is NOT on screen
        // at the moment send_text returns — the agent has to wait.
        const sid = await startDelayedEmitter(
            call,
            'while read line; do sleep 0.3; printf "got: %s\\n" "$line"; done',
        );

        const started = Date.now();
        const r = await call('send_text', {
            sessionId: sid,
            text: 'ping\n',
            waitFor: { pattern: 'got: ping', timeoutMs: 3000, pollIntervalMs: 25 },
        });
        const took = Date.now() - started;
        expect(r.isError).toBeFalsy();

        const data = structured(r) as {
            screen: ScreenBlock;
            waitFor: WaitForBlock;
            bytesSent: number;
        };

        // The waitFor block should be present with matched=true.
        expect(data.waitFor).toBeDefined();
        expect(data.waitFor.matched).toBe(true);
        expect(data.waitFor.match).toBe('got: ping');
        expect(data.waitFor.timedOut).toBe(false);
        expect(data.waitFor.matchedAgainst).toBe('screen');
        expect(data.waitFor.elapsedMs).toBeGreaterThanOrEqual(250);

        // The whole tool call should have blocked ~300 ms for the
        // shell's delay.
        expect(took).toBeGreaterThanOrEqual(250);
        expect(took).toBeLessThan(2500);

        // The after-snapshot was timed to the match — "got: ping" must
        // be on screen.
        expect(data.screen.after.text).toContain('got: ping');
        // waitAfterMs is forced to 0 when waitFor is used.
        expect(data.screen.waitAfterMs).toBe(0);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('supports regex patterns + capture groups', async () => {
        const { call } = newRig();
        const sid = await startDelayedEmitter(
            call,
            'while read line; do sleep 0.2; printf "version=1.2.3 (%s)\\n" "$line"; done',
        );

        const r = await call('send_text', {
            sessionId: sid,
            text: 'check\n',
            waitFor: {
                pattern: 'version=(\\d+)\\.(\\d+)\\.(\\d+)',
                regex: true,
                timeoutMs: 2500,
                pollIntervalMs: 25,
            },
        });
        expect(r.isError).toBeFalsy();

        const data = structured(r) as { waitFor: WaitForBlock };
        expect(data.waitFor.matched).toBe(true);
        expect(Array.isArray(data.waitFor.match)).toBe(true);
        const m = data.waitFor.match as string[];
        expect(m[0]).toBe('version=1.2.3');
        expect(m.slice(1, 4)).toEqual(['1', '2', '3']);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('reports timedOut=true when the pattern never appears (no error)', async () => {
        const { call } = newRig();
        const sid = await startDelayedEmitter(call, 'exec cat');

        const r = await call('send_text', {
            sessionId: sid,
            text: 'hello',
            waitFor: {
                pattern: 'NEVER_GOING_TO_APPEAR',
                timeoutMs: 250,
                pollIntervalMs: 30,
            },
        });
        expect(r.isError).toBeFalsy();

        const data = structured(r) as {
            screen: ScreenBlock;
            waitFor: WaitForBlock;
        };
        expect(data.waitFor.matched).toBe(false);
        expect(data.waitFor.timedOut).toBe(true);
        expect(data.waitFor.match).toBeNull();
        // Capture still returned — cat echoes "hello" back.
        expect(data.screen.after.text).toContain('hello');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('returns an error (isError=true) when errorOnTimeout is set and pattern misses', async () => {
        const { call } = newRig();
        const sid = await startDelayedEmitter(call, 'exec cat');

        const r = await call('send_text', {
            sessionId: sid,
            text: 'hello',
            waitFor: {
                pattern: 'ALSO_NEVER',
                timeoutMs: 200,
                errorOnTimeout: true,
            },
        });
        expect(r.isError).toBe(true);
        // The textual error message mentions the pattern.
        const text0 = result0Text(r);
        expect(text0.toLowerCase()).toContain('also_never');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('send_keys + waitFor', () => {
    it('works when the pattern is already on screen at submit time', async () => {
        const { call } = newRig();
        // Shell that starts by printing "READY" to stdout.  By the time
        // send_keys runs, READY is already visible — waitFor should
        // match immediately.
        const sid = await startDelayedEmitter(call, 'printf "READY\\n"; exec cat');
        // Give the banner time to appear.
        await new Promise((r) => setTimeout(r, 200));

        const r = await call('send_keys', {
            sessionId: sid,
            keys: 'Enter',
            waitFor: { pattern: 'READY', timeoutMs: 2000, pollIntervalMs: 25 },
        });
        expect(r.isError).toBeFalsy();

        const data = structured(r) as { waitFor: WaitForBlock };
        expect(data.waitFor.matched).toBe(true);
        expect(data.waitFor.elapsedMs).toBeLessThan(300);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('type_text + waitFor', () => {
    it('waits for a post-typing marker to appear', async () => {
        const { call } = newRig();
        const sid = await startDelayedEmitter(
            call,
            'while read line; do sleep 0.2; printf "echo: %s\\n" "$line"; done',
        );

        const r = await call('type_text', {
            sessionId: sid,
            text: 'typed\n',
            cps: 500,
            waitFor: { pattern: 'echo: typed', timeoutMs: 3000, pollIntervalMs: 25 },
        });
        expect(r.isError).toBeFalsy();

        const data = structured(r) as {
            screen: ScreenBlock;
            waitFor: WaitForBlock;
        };
        expect(data.waitFor.matched).toBe(true);
        expect(data.screen.after.text).toContain('echo: typed');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

describe('send_text + waitFor + captureScreen=false', () => {
    it('omits the screen block but still reports the waitFor outcome', async () => {
        const { call } = newRig();
        const sid = await startDelayedEmitter(
            call,
            'while read line; do sleep 0.2; printf "ack: %s\\n" "$line"; done',
        );

        const r = await call('send_text', {
            sessionId: sid,
            text: 'foo\n',
            captureScreen: false,
            waitFor: { pattern: 'ack: foo', timeoutMs: 2500, pollIntervalMs: 25 },
        });
        expect(r.isError).toBeFalsy();

        const data = structured(r) as {
            screen?: ScreenBlock;
            waitFor: WaitForBlock;
        };
        expect(data.screen).toBeUndefined();
        expect(data.waitFor).toBeDefined();
        expect(data.waitFor.matched).toBe(true);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});

/** Extract the first text-content chunk from a ToolResult. */
function result0Text(r: ToolResult): string {
    const first = r.content?.[0];
    if (first && 'text' in first && typeof first.text === 'string') return first.text;
    return JSON.stringify(r);
}
