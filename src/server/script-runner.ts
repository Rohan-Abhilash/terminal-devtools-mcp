import { z } from 'zod';

import type { KeyInput } from '../keys/types.js';
import { parseKey } from '../keys/parser.js';
import { encodeKey } from '../keys/encoder.js';
import { Monitor, type MonitorResult } from '../monitor/monitor.js';
import { buildSnapshot, type SnapshotFormat } from '../snapshot/snapshot.js';
import { SessionManager } from '../session/session-manager.js';
import type { TerminalSession } from '../session/terminal-session.js';
import { holdKey, typeText, waitForIdle } from '../session/wait.js';
import {
    captureAround,
    type CaptureResult,
    type WaitForOutcome,
    type WaitForSpec,
} from './capture.js';

const KeyInputSchema: z.ZodType<KeyInput> = z.union([
    z.string().describe('A key combination string, e.g. "a", "ctrl+c", "shift+tab", "F5".'),
    z.object({
        key: z.string().min(1),
        ctrl: z.boolean().optional(),
        shift: z.boolean().optional(),
        alt: z.boolean().optional(),
        meta: z.boolean().optional(),
    }).describe('A structured key spec.'),
]);

const CaptureScreenField = z.boolean().optional().describe(
    'Capture before/after visible screen text and a row-level diff for this step. Default comes from defaults.captureScreen, then true.',
);

const WaitAfterMsField = z.number().int().min(0).max(5000).optional().describe(
    'Post-step settle delay before the after-snapshot. Defaults to defaults.waitAfterMs, then the step kind default.',
);

const WaitForObjectSchema = z.object({
    pattern: z.string().min(1).describe('Literal text by default, or a RegExp source when regex=true.'),
    regex: z.boolean().optional().describe('Treat pattern as a RegExp source. Default false.'),
    regexFlags: z.string().optional().describe('Flags for the RegExp, e.g. "i", "m", "s".'),
    timeoutMs: z.number().int().min(10).max(600_000).optional().describe('Max wait. Defaults to defaults.timeoutMs, then 5000.'),
    pollIntervalMs: z.number().int().min(10).max(5_000).optional().describe('Poll gap. Defaults to defaults.pollIntervalMs, then 50.'),
    matchScreen: z.boolean().optional().describe('Match visible screen text (true) or raw PTY output (false).'),
    errorOnTimeout: z.boolean().optional().describe('If true, a miss fails the step. Default false for nested input waitFor, true for wait_for_text steps.'),
});

const StepBase = {
    label: z.string().optional().describe('Optional human-readable label echoed in the result.'),
    continueOnError: z.boolean().optional().describe('Continue after this step fails even when stopOnError=true.'),
};

const ObservableStepBase = {
    ...StepBase,
    captureScreen: CaptureScreenField,
    waitAfterMs: WaitAfterMsField,
};

const ScriptStepSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('send_keys'),
        ...ObservableStepBase,
        keys: z.union([KeyInputSchema, z.array(KeyInputSchema)]).describe('Single key or ordered key list.'),
        waitFor: WaitForObjectSchema.optional().describe('After sending, poll for this pattern before the step returns.'),
    }),
    z.object({
        type: z.literal('send_text'),
        ...ObservableStepBase,
        text: z.string().describe('Literal text to send to stdin.'),
        waitFor: WaitForObjectSchema.optional().describe('After sending, poll for this pattern before the step returns.'),
    }),
    z.object({
        type: z.literal('send_raw'),
        ...ObservableStepBase,
        hex: z.string().optional().describe('Bytes as even-length hex.'),
        base64: z.string().optional().describe('Bytes as base64.'),
        utf8: z.string().optional().describe('Bytes as a UTF-8 string.'),
        waitFor: WaitForObjectSchema.optional().describe('After sending, poll for this pattern before the step returns.'),
    }),
    z.object({
        type: z.literal('type_text'),
        ...ObservableStepBase,
        text: z.string().describe('Text to type with per-character delay.'),
        cps: z.number().positive().max(1000).optional().describe('Characters per second. Default 80.'),
        waitFor: WaitForObjectSchema.optional().describe('After typing, poll for this pattern before the step returns.'),
    }),
    z.object({
        type: z.literal('hold_key'),
        ...ObservableStepBase,
        key: KeyInputSchema.describe('Key to repeat.'),
        durationMs: z.number().int().positive().max(60_000).describe('How long to hold the key.'),
        intervalMs: z.number().int().positive().max(5_000).optional().describe('Gap between repeated events. Default 30.'),
        waitFor: WaitForObjectSchema.optional().describe('After the hold ends, poll for this pattern before the step returns.'),
    }),
    z.object({
        type: z.literal('wait_for_text'),
        ...ObservableStepBase,
        pattern: z.string().min(1).describe('Literal text by default, or a RegExp source when regex=true.'),
        regex: z.boolean().optional().describe('Treat pattern as a RegExp source. Default false.'),
        regexFlags: z.string().optional().describe('Flags for the RegExp, e.g. "i", "m", "s".'),
        timeoutMs: z.number().int().min(10).max(600_000).optional().describe('Max wait. Defaults to defaults.timeoutMs, then 5000.'),
        pollIntervalMs: z.number().int().min(10).max(5_000).optional().describe('Poll gap. Defaults to defaults.pollIntervalMs, then 50.'),
        matchScreen: z.boolean().optional().describe('Match visible screen text (true) or raw PTY output (false).'),
        errorOnTimeout: z.boolean().optional().describe('Fail the step on timeout. Default true.'),
    }),
    z.object({
        type: z.literal('wait_for_idle'),
        ...ObservableStepBase,
        idleMs: z.number().int().positive().max(60_000).optional().describe('Required quiet period. Default 500.'),
        timeoutMs: z.number().int().positive().max(600_000).optional().describe('Max wait. Default 10000.'),
        pollIntervalMs: z.number().int().positive().optional().describe('Poll gap. Default 50.'),
    }),
    z.object({
        type: z.literal('sleep'),
        ...ObservableStepBase,
        durationMs: z.number().int().min(0).max(600_000).describe('Wall-clock delay before continuing.'),
    }),
    z.object({
        type: z.literal('assert_text'),
        ...StepBase,
        pattern: z.string().min(1).describe('Literal text by default, or a RegExp source when regex=true.'),
        regex: z.boolean().optional().describe('Treat pattern as a RegExp source. Default false.'),
        regexFlags: z.string().optional().describe('Flags for the RegExp, e.g. "i", "m", "s".'),
        matchScreen: z.boolean().optional().describe('Match visible screen text (true) or raw PTY output (false).'),
        negate: z.boolean().optional().describe('Pass when the pattern is absent instead of present. Default false.'),
        errorOnMismatch: z.boolean().optional().describe('Fail the step when the assertion does not pass. Default true.'),
        includeText: z.boolean().optional().describe('Include the full haystack text in the result. Default false to keep payload small. Tip: use a separate snapshot/get_text step or get_raw_output if you need the full text.'),
        excerptBytes: z.number().int().min(0).max(20_000).optional().describe('When includeText is false, attach a small excerpt around the match (or the tail when no match). Default 200; set 0 to omit.'),
    }),
    z.object({
        type: z.literal('snapshot'),
        ...StepBase,
        format: z.enum(['text', 'ansi', 'cells', 'all']).optional().describe('Snapshot format. Default text.'),
        includeScrollback: z.boolean().optional().describe('Include full terminal scrollback. Default false.'),
        maxScrollbackLines: z.number().int().positive().max(100_000).optional().describe('Scrollback line cap. Default 10000.'),
    }),
    z.object({
        type: z.literal('get_text'),
        ...StepBase,
        includeScrollback: z.boolean().optional().describe('Include full terminal scrollback. Default false.'),
        maxScrollbackLines: z.number().int().positive().max(100_000).optional().describe('Scrollback line cap. Default 10000.'),
    }),
    z.object({
        type: z.literal('resize'),
        ...StepBase,
        cols: z.number().int().positive().max(1000),
        rows: z.number().int().positive().max(1000),
    }),
]);

const DefaultsSchema = z.object({
    captureScreen: z.boolean().optional().describe('Default captureScreen for observable steps. Default true.'),
    waitAfterMs: z.number().int().min(0).max(5000).optional().describe('Default post-step settle delay.'),
    timeoutMs: z.number().int().min(10).max(600_000).optional().describe('Default text wait timeout.'),
    pollIntervalMs: z.number().int().min(10).max(5_000).optional().describe('Default text wait poll interval.'),
    matchScreen: z.boolean().optional().describe('Default text wait target. True=visible screen, false=raw PTY output.'),
});

const WholeScriptMonitorSchema = z.object({
    enabled: z.boolean().optional().describe('Set false to disable when a monitor object is supplied. Default true.'),
    intervalMs: z.number().int().positive().max(5_000).optional().describe('Sampling interval. Default 100.'),
    keepIdenticalFrames: z.boolean().optional().describe('Keep unchanged samples too. Default false.'),
    maxFrames: z.number().int().positive().max(100_000).optional().describe('Hard cap on returned frames. Default 5000.'),
});

export const RunScriptInputSchema = {
    sessionId: z.string().min(1).describe('ID of an active session.'),
    steps: z.array(ScriptStepSchema).min(1).max(500).describe(
        'Ordered steps to execute inside the MCP server before returning. This removes agent round-trip latency between input, waits, assertions, snapshots, and monitoring.',
    ),
    defaults: DefaultsSchema.optional().describe('Defaults inherited by steps unless a step overrides them.'),
    stopOnError: z.boolean().optional().describe('Stop at the first failed step. Default true. Step continueOnError overrides this.'),
    monitor: WholeScriptMonitorSchema.optional().describe(
        'Record frame-level screen changes for the entire script and return them with the result. Use this to observe fast transient UI states while steps continue.',
    ),
    returnFinalSnapshot: z.boolean().optional().describe('Include a final text snapshot after all executed steps. Default true.'),
    includeRawOutput: z.boolean().optional().describe('Include raw PTY output emitted during the script, subject to rawOutputTailBytes. Default false.'),
    rawOutputTailBytes: z.number().int().positive().max(10_000_000).optional().describe('Cap for rawOutput.output. Default 1 000 000. Tail is kept.'),
} satisfies z.ZodRawShape;

const RunScriptInputObject = z.object(RunScriptInputSchema);

type ScriptStep = z.infer<typeof ScriptStepSchema>;
type ScriptDefaults = z.infer<typeof DefaultsSchema>;
type WaitForInput = z.infer<typeof WaitForObjectSchema>;
type ObservableInputStep = Extract<ScriptStep, {
    type: 'send_keys' | 'send_text' | 'send_raw' | 'type_text' | 'hold_key';
}>;

interface ScriptStepResult {
    index: number;
    type: string;
    label?: string;
    ok: boolean;
    startedAt: number;
    endedAt: number;
    elapsedMs: number;
    result?: Record<string, unknown>;
    error?: { name: string; message: string };
}

export interface ScriptRunResult {
    sessionId: string;
    ok: boolean;
    stepsPlanned: number;
    stepsRun: number;
    stoppedAtStep: number | null;
    durationMs: number;
    results: ScriptStepResult[];
    monitor?: MonitorResult;
    finalSnapshot?: Record<string, unknown>;
    rawOutput?: {
        bytes: number;
        output: string;
        truncated: boolean;
        prefixMatched: boolean;
        tailBytes: number;
    };
}

export async function runScript(
    manager: SessionManager,
    rawInput: Record<string, unknown>,
): Promise<ScriptRunResult> {
    const input = RunScriptInputObject.parse(rawInput);
    const session = manager.get(input.sessionId);
    const startedAt = Date.now();
    const defaults = input.defaults ?? {};
    const stopOnError = input.stopOnError !== false;
    const rawStart = input.includeRawOutput ? session.rawOutput() : null;
    let monitor: Monitor | null = null;
    let monitorResult: MonitorResult | undefined;
    const results: ScriptStepResult[] = [];
    let stoppedAtStep: number | null = null;

    if (input.monitor && input.monitor.enabled !== false) {
        monitor = manager.startMonitor(session.id, {
            intervalMs: input.monitor.intervalMs,
            keepIdenticalFrames: input.monitor.keepIdenticalFrames,
            maxFrames: input.monitor.maxFrames,
        });
    }

    try {
        for (let i = 0; i < input.steps.length; i += 1) {
            const step = input.steps[i]!;
            const result = await runStep(session, step, defaults, i);
            results.push(result);
            if (!result.ok && stopOnError && step.continueOnError !== true) {
                stoppedAtStep = i;
                break;
            }
        }
    } finally {
        if (monitor) {
            await session.whenParserFlushed().catch(() => undefined);
            await monitor.sampleNow();
            monitorResult = manager.stopMonitor(monitor.id);
        }
    }

    const ok = results.every((r) => r.ok);
    const output: ScriptRunResult = {
        sessionId: session.id,
        ok,
        stepsPlanned: input.steps.length,
        stepsRun: results.length,
        stoppedAtStep,
        durationMs: Date.now() - startedAt,
        results,
    };

    if (monitorResult) {
        output.monitor = monitorResult;
    }

    if (input.returnFinalSnapshot !== false) {
        await session.whenParserFlushed();
        output.finalSnapshot = snapshotPayload(session, 'text', {});
    }

    if (rawStart !== null) {
        output.rawOutput = rawOutputDelta(session, rawStart, input.rawOutputTailBytes ?? 1_000_000);
    }

    return output;
}

async function runStep(
    session: TerminalSession,
    step: ScriptStep,
    defaults: ScriptDefaults,
    index: number,
): Promise<ScriptStepResult> {
    const startedAt = Date.now();
    try {
        const result = await executeStep(session, step, defaults);
        const endedAt = Date.now();
        return {
            index,
            type: step.type,
            label: step.label,
            ok: true,
            startedAt,
            endedAt,
            elapsedMs: endedAt - startedAt,
            result,
        };
    } catch (err) {
        const endedAt = Date.now();
        return {
            index,
            type: step.type,
            label: step.label,
            ok: false,
            startedAt,
            endedAt,
            elapsedMs: endedAt - startedAt,
            error: {
                name: err instanceof Error ? err.name : 'Error',
                message: err instanceof Error ? err.message : String(err),
            },
        };
    }
}

async function executeStep(
    session: TerminalSession,
    step: ScriptStep,
    defaults: ScriptDefaults,
): Promise<Record<string, unknown>> {
    switch (step.type) {
        case 'send_keys': {
            const rawKeys = step.keys as KeyInput | KeyInput[];
            const list = Array.isArray(rawKeys) ? rawKeys : [rawKeys];
            const specs = list.map(parseKey);
            const bytes = specs.map(encodeKey).join('');
            const { capture, waitFor } = await runObservable(session, step, defaults, () => {
                session.writeRaw(bytes);
            });
            return withObservation({
                keyCount: specs.length,
                bytesSent: bytes.length,
                specs,
            }, capture, waitFor);
        }
        case 'send_text': {
            const { capture, waitFor } = await runObservable(session, step, defaults, () => {
                session.sendText(step.text);
            });
            return withObservation({
                bytesSent: step.text.length,
            }, capture, waitFor);
        }
        case 'send_raw': {
            const bytes = rawBytesFromStep(step);
            const { capture, waitFor } = await runObservable(session, step, defaults, () => {
                session.writeRaw(bytes);
            });
            return withObservation({
                bytesSent: bytes.length,
            }, capture, waitFor);
        }
        case 'type_text': {
            const { capture, waitFor } = await runObservable(session, step, defaults, async () => {
                await typeText(session, step.text, { cps: step.cps });
            });
            return withObservation({
                chars: step.text.length,
            }, capture, waitFor);
        }
        case 'hold_key': {
            const spec = parseKey(step.key as KeyInput);
            const bytes = encodeKey(spec);
            let events = 0;
            const { capture, waitFor } = await runObservable(session, step, defaults, async () => {
                const held = await holdKey(session, bytes, {
                    durationMs: step.durationMs,
                    intervalMs: step.intervalMs,
                });
                events = held.events;
            });
            return withObservation({ events, spec }, capture, waitFor);
        }
        case 'wait_for_text': {
            const waitSpec = waitSpecFromTextStep(step, defaults);
            const { capture, waitFor } = await captureAround(session, () => undefined, {
                enabled: captureEnabled(step, defaults),
                waitAfterMs: waitAfterMs(step, defaults, 0),
                waitFor: waitSpec,
            });
            return withObservation({}, capture, waitFor);
        }
        case 'wait_for_idle': {
            let idleResult: unknown = {};
            const { capture } = await captureAround(session, async () => {
                idleResult = await waitForIdle(session, {
                    idleMs: step.idleMs,
                    timeoutMs: step.timeoutMs,
                    pollIntervalMs: step.pollIntervalMs,
                });
            }, {
                enabled: captureEnabled(step, defaults),
                waitAfterMs: waitAfterMs(step, defaults, 0),
            });
            return withObservation({ waitForIdle: idleResult }, capture, null);
        }
        case 'sleep': {
            const { capture } = await captureAround(session, async () => {
                await delay(step.durationMs);
            }, {
                enabled: captureEnabled(step, defaults),
                waitAfterMs: waitAfterMs(step, defaults, 0),
            });
            return withObservation({ sleptMs: step.durationMs }, capture, null);
        }
        case 'assert_text': {
            return assertText(session, step, defaults);
        }
        case 'snapshot': {
            await session.whenParserFlushed();
            return snapshotPayload(session, step.format ?? 'text', {
                includeScrollback: step.includeScrollback,
                maxScrollbackLines: step.maxScrollbackLines,
            });
        }
        case 'get_text': {
            await session.whenParserFlushed();
            return snapshotPayload(session, 'text', {
                includeScrollback: step.includeScrollback,
                maxScrollbackLines: step.maxScrollbackLines,
            });
        }
        case 'resize': {
            session.resize(step.cols, step.rows);
            await session.whenParserFlushed();
            return { cols: session.cols, rows: session.rows };
        }
    }
}

function runObservable(
    session: TerminalSession,
    step: ObservableInputStep,
    defaults: ScriptDefaults,
    action: () => void | Promise<void>,
): Promise<{ capture: CaptureResult | null; waitFor: WaitForOutcome | null }> {
    return captureAround(session, action, {
        enabled: captureEnabled(step, defaults),
        waitAfterMs: waitAfterMs(step, defaults, undefined),
        waitFor: waitSpecFromNested(step.waitFor, defaults),
    });
}

function captureEnabled(
    step: { captureScreen?: boolean },
    defaults: ScriptDefaults,
): boolean {
    return (step.captureScreen ?? defaults.captureScreen) !== false;
}

function waitAfterMs(
    step: { waitAfterMs?: number },
    defaults: ScriptDefaults,
    fallback: number | undefined,
): number | undefined {
    return step.waitAfterMs ?? defaults.waitAfterMs ?? fallback;
}

function waitSpecFromNested(
    waitFor: WaitForInput | undefined,
    defaults: ScriptDefaults,
): WaitForSpec | undefined {
    if (!waitFor) return undefined;
    return {
        pattern: patternFromInput(waitFor.pattern, waitFor.regex, waitFor.regexFlags),
        timeoutMs: waitFor.timeoutMs ?? defaults.timeoutMs,
        pollIntervalMs: waitFor.pollIntervalMs ?? defaults.pollIntervalMs,
        matchScreen: waitFor.matchScreen ?? defaults.matchScreen,
        errorOnTimeout: waitFor.errorOnTimeout,
    };
}

function waitSpecFromTextStep(
    step: Extract<ScriptStep, { type: 'wait_for_text' }>,
    defaults: ScriptDefaults,
): WaitForSpec {
    return {
        pattern: patternFromInput(step.pattern, step.regex, step.regexFlags),
        timeoutMs: step.timeoutMs ?? defaults.timeoutMs,
        pollIntervalMs: step.pollIntervalMs ?? defaults.pollIntervalMs,
        matchScreen: step.matchScreen ?? defaults.matchScreen,
        errorOnTimeout: step.errorOnTimeout !== false,
    };
}

function patternFromInput(pattern: string, regex?: boolean, regexFlags?: string): string | RegExp {
    return regex ? new RegExp(pattern, regexFlags ?? '') : pattern;
}

function withObservation(
    base: Record<string, unknown>,
    capture: CaptureResult | null,
    waitFor: WaitForOutcome | null,
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };
    if (capture) {
        out.screen = {
            before: capture.before,
            after: capture.after,
            diff: capture.diff,
            waitAfterMs: capture.waitAfterMs,
            totalMs: capture.totalMs,
        };
    }
    if (waitFor) {
        out.waitFor = waitFor;
    }
    return out;
}

function rawBytesFromStep(step: Extract<ScriptStep, { type: 'send_raw' }>): string {
    const provided = [step.hex, step.base64, step.utf8].filter((v) => typeof v === 'string').length;
    if (provided !== 1) {
        throw new Error('send_raw step must provide exactly one of { hex, base64, utf8 }');
    }
    if (typeof step.hex === 'string') {
        const hex = step.hex.replace(/\s+/g, '');
        if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
            throw new Error('hex must be an even-length hex string');
        }
        return Buffer.from(hex, 'hex').toString('binary');
    }
    if (typeof step.base64 === 'string') {
        return Buffer.from(step.base64, 'base64').toString('binary');
    }
    return step.utf8 ?? '';
}

async function assertText(
    session: TerminalSession,
    step: Extract<ScriptStep, { type: 'assert_text' }>,
    defaults: ScriptDefaults,
): Promise<Record<string, unknown>> {
    await session.whenParserFlushed();
    const matchedAgainst = (step.matchScreen ?? defaults.matchScreen) === false ? 'raw' : 'screen';
    const text = matchedAgainst === 'screen'
        ? buildSnapshot(session.terminal, 'text').text
        : session.rawOutput();
    const pattern = patternFromInput(step.pattern, step.regex, step.regexFlags);
    const match = matchPattern(text, pattern);
    const matched = match !== null;
    const passed = step.negate ? !matched : matched;
    const patternStr = typeof pattern === 'string' ? pattern : pattern.toString();
    const result: Record<string, unknown> = {
        passed,
        matched,
        match,
        pattern: patternStr,
        matchedAgainst,
        negated: step.negate === true,
        textLength: text.length,
    };
    if (step.includeText) {
        result.text = text;
    } else {
        const excerptBytes = step.excerptBytes ?? 200;
        if (excerptBytes > 0) {
            result.excerpt = excerptText(text, pattern, excerptBytes);
        }
    }
    if (!passed && step.errorOnMismatch !== false) {
        throw new Error(`assert_text failed: pattern ${patternStr} ${step.negate ? 'was present' : 'was not present'} in ${matchedAgainst}`);
    }
    return result;
}

function excerptText(text: string, pattern: string | RegExp, maxBytes: number): string {
    if (text.length === 0) return '';
    let centerStart = -1;
    let centerEnd = -1;
    if (typeof pattern === 'string') {
        const idx = text.indexOf(pattern);
        if (idx >= 0) {
            centerStart = idx;
            centerEnd = idx + pattern.length;
        }
    } else {
        const m = text.match(pattern);
        if (m && typeof m.index === 'number') {
            centerStart = m.index;
            centerEnd = m.index + (m[0]?.length ?? 0);
        }
    }
    if (centerStart < 0) {
        if (text.length <= maxBytes) return text;
        return text.slice(text.length - maxBytes);
    }
    const span = Math.max(0, maxBytes - (centerEnd - centerStart));
    const before = Math.floor(span / 2);
    const start = Math.max(0, centerStart - before);
    const end = Math.min(text.length, start + maxBytes);
    return text.slice(start, end);
}

function matchPattern(text: string, pattern: string | RegExp): string | string[] | null {
    if (typeof pattern === 'string') {
        return text.includes(pattern) ? pattern : null;
    }
    const match = text.match(pattern);
    return match ? Array.from(match) : null;
}

function snapshotPayload(
    session: TerminalSession,
    format: SnapshotFormat,
    opts: { includeScrollback?: boolean; maxScrollbackLines?: number },
): Record<string, unknown> {
    const snap = buildSnapshot(session.terminal, format, {
        includeScrollback: opts.includeScrollback,
        maxScrollbackLines: opts.maxScrollbackLines,
    });
    return {
        cols: snap.cols,
        rows: snap.rows,
        cursor: snap.cursor,
        text: snap.text,
        ansi: snap.ansi,
        cells: snap.cells,
        scrollback: snap.scrollback,
        takenAt: snap.takenAt,
    };
}

function rawOutputDelta(
    session: TerminalSession,
    rawStart: string,
    tailBytes: number,
): {
    bytes: number;
    output: string;
    truncated: boolean;
    prefixMatched: boolean;
    tailBytes: number;
} {
    const rawEnd = session.rawOutput();
    const prefixMatched = rawEnd.startsWith(rawStart);
    let output = prefixMatched ? rawEnd.slice(rawStart.length) : rawEnd;
    let truncated = !prefixMatched;
    if (output.length > tailBytes) {
        output = output.slice(output.length - tailBytes);
        truncated = true;
    }
    return {
        bytes: output.length,
        output,
        truncated,
        prefixMatched,
        tailBytes,
    };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
