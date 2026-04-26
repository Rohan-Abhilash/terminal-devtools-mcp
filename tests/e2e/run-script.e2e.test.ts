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
    return { manager, call };
}

function structured(result: ToolResult): Record<string, unknown> {
    if (!result.structuredContent) {
        throw new Error(`result has no structured content: ${JSON.stringify(result)}`);
    }
    return result.structuredContent;
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

describe('run_script', () => {
    it('executes send/wait/assert/snapshot steps and returns monitor + raw output', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', [
                'while IFS= read -r line; do',
                '  case "$line" in',
                '    first) sleep 0.1; printf "FIRST_READY\\n" ;;',
                '    second) sleep 0.1; printf "SECOND_READY\\n" ;;',
                '  esac',
                'done',
            ].join('\n')],
            cols: 80,
            rows: 12,
        })) as { sessionId: string }).sessionId;

        await new Promise((r) => setTimeout(r, 100));

        const result = await call('run_script', {
            sessionId: sid,
            defaults: { pollIntervalMs: 20, timeoutMs: 2500 },
            monitor: { intervalMs: 20, maxFrames: 100 },
            includeRawOutput: true,
            steps: [
                {
                    type: 'send_text',
                    label: 'submit first',
                    text: 'first\n',
                    waitFor: { pattern: 'FIRST_READY' },
                },
                {
                    type: 'send_text',
                    label: 'submit second',
                    text: 'second\n',
                    waitFor: { pattern: 'SECOND_READY' },
                },
                { type: 'assert_text', pattern: 'SECOND_READY' },
                { type: 'snapshot' },
            ],
        });

        expect(result.isError).toBeFalsy();
        const data = structured(result) as {
            ok: boolean;
            stepsRun: number;
            results: Array<{ ok: boolean; result?: { waitFor?: { matched: boolean }; text?: string } }>;
            monitor?: { frameCount: number; frames: Array<{ text: string }> };
            rawOutput?: { output: string; truncated: boolean };
            finalSnapshot?: { text: string };
        };

        expect(data.ok).toBe(true);
        expect(data.stepsRun).toBe(4);
        expect(data.results.every((r) => r.ok)).toBe(true);
        expect(data.results[0]!.result!.waitFor!.matched).toBe(true);
        expect(data.results[1]!.result!.waitFor!.matched).toBe(true);
        expect(data.results[3]!.result!.text).toContain('SECOND_READY');
        expect(data.monitor).toBeDefined();
        expect(data.monitor!.frameCount).toBeGreaterThan(0);
        expect(data.monitor!.frames.map((f) => f.text).join('\n')).toContain('SECOND_READY');
        expect(data.rawOutput).toBeDefined();
        expect(data.rawOutput!.output).toContain('FIRST_READY');
        expect(data.rawOutput!.output).toContain('SECOND_READY');
        expect(data.rawOutput!.truncated).toBe(false);
        expect(data.finalSnapshot!.text).toContain('SECOND_READY');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('stops at the first failed step by default and returns partial results as isError', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'exec cat'],
            cols: 60,
            rows: 8,
        })) as { sessionId: string }).sessionId;

        await new Promise((r) => setTimeout(r, 100));

        const result = await call('run_script', {
            sessionId: sid,
            steps: [
                {
                    type: 'wait_for_text',
                    pattern: 'NEVER_SEEN',
                    timeoutMs: 100,
                    pollIntervalMs: 20,
                },
                {
                    type: 'send_text',
                    text: 'should-not-run\n',
                },
            ],
        });

        expect(result.isError).toBe(true);
        const data = structured(result) as {
            ok: boolean;
            stepsPlanned: number;
            stepsRun: number;
            stoppedAtStep: number | null;
            results: Array<{ ok: boolean; error?: { message: string } }>;
            finalSnapshot?: { text: string };
        };

        expect(data.ok).toBe(false);
        expect(data.stepsPlanned).toBe(2);
        expect(data.stepsRun).toBe(1);
        expect(data.stoppedAtStep).toBe(0);
        expect(data.results[0]!.ok).toBe(false);
        expect(data.results[0]!.error!.message).toContain('NEVER_SEEN');
        expect(data.finalSnapshot!.text).not.toContain('should-not-run');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('can continue after a failed assertion when continueOnError is set', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'exec cat'],
            cols: 60,
            rows: 8,
        })) as { sessionId: string }).sessionId;

        await new Promise((r) => setTimeout(r, 100));

        const result = await call('run_script', {
            sessionId: sid,
            steps: [
                {
                    type: 'assert_text',
                    pattern: 'ABSENT',
                    continueOnError: true,
                },
                {
                    type: 'send_text',
                    text: 'continued\n',
                    waitFor: { pattern: 'continued', timeoutMs: 1500 },
                },
            ],
        });

        expect(result.isError).toBe(true);
        const data = structured(result) as {
            ok: boolean;
            stepsRun: number;
            results: Array<{ ok: boolean; result?: { waitFor?: { matched: boolean } } }>;
            finalSnapshot?: { text: string };
        };

        expect(data.ok).toBe(false);
        expect(data.stepsRun).toBe(2);
        expect(data.results[0]!.ok).toBe(false);
        expect(data.results[1]!.ok).toBe(true);
        expect(data.results[1]!.result!.waitFor!.matched).toBe(true);
        expect(data.finalSnapshot!.text).toContain('continued');

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });

    it('assert_text omits full haystack by default and provides an excerpt', async () => {
        const { call } = newRig();
        const sid = (structured(await call('start_session', {
            command: 'bash',
            args: ['-c', 'printf "MARKER_START\\n"; for i in $(seq 1 200); do printf "filler line %s\\n" $i; done; printf "MARKER_END\\n"; exec cat'],
            cols: 80,
            rows: 6,
        })) as { sessionId: string }).sessionId;

        // Let the producer finish so MARKER_END is in the raw output.
        await new Promise((r) => setTimeout(r, 350));

        const result = await call('run_script', {
            sessionId: sid,
            returnFinalSnapshot: false,
            steps: [
                {
                    type: 'assert_text',
                    label: 'no text by default',
                    pattern: 'MARKER_END',
                    matchScreen: false,
                },
                {
                    type: 'assert_text',
                    label: 'with includeText',
                    pattern: 'MARKER_END',
                    matchScreen: false,
                    includeText: true,
                },
                {
                    type: 'assert_text',
                    label: 'no excerpt either',
                    pattern: 'MARKER_END',
                    matchScreen: false,
                    excerptBytes: 0,
                },
            ],
        });

        expect(result.isError).toBeFalsy();
        const data = structured(result) as {
            ok: boolean;
            results: Array<{
                ok: boolean;
                result?: {
                    passed: boolean;
                    matched: boolean;
                    text?: string;
                    excerpt?: string;
                    textLength: number;
                };
            }>;
        };

        expect(data.ok).toBe(true);

        const r0 = data.results[0]!.result!;
        expect(r0.passed).toBe(true);
        expect(r0.text).toBeUndefined();
        expect(typeof r0.excerpt).toBe('string');
        expect(r0.excerpt!.length).toBeLessThanOrEqual(200);
        expect(r0.excerpt).toContain('MARKER_END');
        expect(r0.textLength).toBeGreaterThan(r0.excerpt!.length);

        const r1 = data.results[1]!.result!;
        expect(r1.passed).toBe(true);
        expect(typeof r1.text).toBe('string');
        expect(r1.text).toContain('MARKER_START');
        expect(r1.text).toContain('MARKER_END');
        expect(r1.text!.length).toBe(r1.textLength);

        const r2 = data.results[2]!.result!;
        expect(r2.text).toBeUndefined();
        expect(r2.excerpt).toBeUndefined();
        expect(r2.textLength).toBeGreaterThan(0);

        await call('stop_session', { sessionId: sid, signal: 'SIGKILL' });
    });
});
