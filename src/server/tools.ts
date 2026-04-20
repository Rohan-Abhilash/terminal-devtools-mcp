/**
 * Tool definitions — every tool exposed to MCP clients lives here.
 * Each tool has:
 *
 *   • name          — what the MCP client uses to call it
 *   • description   — shown to the model as a hint
 *   • inputSchema   — a Zod shape; the SDK validates input for us
 *   • handler       — async fn taking parsed input, returning ToolResult
 *
 * Handlers are written to be defensive: they always return structured
 * results via `safely()`, never throw out to the protocol layer.
 */

import { z } from 'zod';

import { KeyInput } from '../keys/types.js';
import { parseKey } from '../keys/parser.js';
import { encodeKey } from '../keys/encoder.js';
import { SessionManager } from '../session/session-manager.js';
import { buildSnapshot, type SnapshotFormat } from '../snapshot/snapshot.js';
import { diffSnapshots } from '../snapshot/diff.js';
import { holdKey, typeText, waitForIdle, waitForText } from '../session/wait.js';

import {
    captureAround,
    WaitForTimeoutError,
    type CaptureResult,
    type WaitForOutcome,
    type WaitForSpec,
} from './capture.js';
import { error, json, safely, text, ToolResult } from './result.js';

// ── Input-shape fragments reused across tools ─────────────────────────

const SessionIdField = z.string().min(1).describe('ID of an active session (from start_session).');

const KeyInputSchema: z.ZodType<KeyInput> = z.union([
    z.string().describe(
        'A key combination string, e.g. "a", "ctrl+c", "ctrl+shift+up", "F5", "Enter", "shift+tab".',
    ),
    z.object({
        key: z.string().min(1),
        ctrl: z.boolean().optional(),
        shift: z.boolean().optional(),
        alt: z.boolean().optional(),
        meta: z.boolean().optional(),
    }).describe('A structured key spec.'),
]);

// ── Shared options for every "send input" tool ────────────────────────
//
// `captureScreen` (default true) + `waitAfterMs` (default 150) make
// every input tool also return a before/after snapshot of the screen
// plus a compact diff — the caller sees exactly what their keystroke
// did without a separate `snapshot()` round-trip.

const CaptureScreenField = z.boolean().optional().describe(
    'Include a "screen" block in the response with the terminal state before and after ' +
    'the input, plus a row-level diff of what changed. Default true.',
);
const WaitAfterMsField = z.number().int().min(0).max(5000).optional().describe(
    'When captureScreen is true, wait this many ms after flushing the parser before taking ' +
    'the "after" snapshot — gives the TUI a chance to re-render in response to the input. ' +
    'Default 150. Set to 0 for the absolute tightest capture. Ignored when `waitFor` is ' +
    'provided (pattern-polling replaces the fixed settle window).',
);

/**
 * Optional "land the input, then wait for this specific text on screen
 * before returning" parameter — shared across every input tool so an
 * agent can observe transient post-input states (spinners resolving,
 * prompts flashing, streamed output settling) without racing a separate
 * `wait_for_text` round-trip.
 */
const WaitForField = z.object({
    pattern: z.string().min(1).describe(
        'Text or RegExp source to look for after the input lands. Treated as a literal ' +
        'substring by default; pass `regex: true` to treat it as a RegExp.',
    ),
    regex: z.boolean().optional().describe(
        'When true, interpret `pattern` as a RegExp source (with `regexFlags`). Default false.',
    ),
    regexFlags: z.string().optional().describe(
        'Flags for the RegExp (e.g. "i", "m", "s"). Only used when `regex: true`.',
    ),
    timeoutMs: z.number().int().min(10).max(600_000).optional().describe(
        'How long to poll for the pattern before giving up. Default 5 000 ms.',
    ),
    pollIntervalMs: z.number().int().min(10).max(5_000).optional().describe(
        'Gap between polls. Default 50 ms.',
    ),
    matchScreen: z.boolean().optional().describe(
        'When true (default) the pattern is matched against the visible screen text. ' +
        'When false it is matched against the raw PTY output buffer — use this when the ' +
        'expected text scrolls past the viewport faster than the poll interval can catch.',
    ),
    errorOnTimeout: z.boolean().optional().describe(
        'When true, a miss causes the tool to return an error. When false (default) the ' +
        'tool still returns normally with `waitFor.matched: false, waitFor.timedOut: true` ' +
        'so the caller can inspect the after-snapshot and decide what to do.',
    ),
}).optional().describe(
    'Land the input, then poll the terminal for this pattern and snapshot AS SOON AS it ' +
    'appears (or the timeout elapses). Prevents missing transient post-input states that ' +
    'would otherwise disappear between the `send_*` call and a follow-up `wait_for_text`. ' +
    'Pair with `captureScreen: true` (the default) to get the exact screen at the moment ' +
    'the pattern matched.',
);

function parseWaitForInput(raw: unknown): WaitForSpec | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as {
        pattern: string;
        regex?: boolean;
        regexFlags?: string;
        timeoutMs?: number;
        pollIntervalMs?: number;
        matchScreen?: boolean;
        errorOnTimeout?: boolean;
    };
    const pattern: string | RegExp = obj.regex
        ? new RegExp(obj.pattern, obj.regexFlags ?? '')
        : obj.pattern;
    return {
        pattern,
        timeoutMs: obj.timeoutMs,
        pollIntervalMs: obj.pollIntervalMs,
        matchScreen: obj.matchScreen,
        errorOnTimeout: obj.errorOnTimeout,
    };
}

/**
 * Merge a `CaptureResult` and optional `WaitForOutcome` into a tool's
 * JSON payload.  `screen` contains the before/after/diff block;
 * `waitFor` carries the pattern-polling result.  Either may be absent
 * depending on what the caller requested.
 */
function withScreen(
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

// ── Tool schemas + handlers ───────────────────────────────────────────

/**
 * A tool registration — passed to McpServer.registerTool as
 * `(name, { description, inputSchema }, handler)`.
 */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: z.ZodRawShape;
    handler: (input: Record<string, unknown>) => Promise<ToolResult>;
}

export function buildTools(manager: SessionManager): ToolDefinition[] {
    return [
        // ── start_session ─────────────────────────────────────────────
        {
            name: 'start_session',
            description:
                'Spawn a new terminal user interface inside a fresh pseudo-terminal (PTY). ' +
                'Returns a session ID that every other tool takes as input. The child process ' +
                'sees a real TTY with the provided cols/rows/TERM/env, so any TUI (curses, ' +
                'Ink, Bubble Tea, etc.) behaves exactly as it would in a normal terminal.\n\n' +
                'GUIDANCE FOR AI AGENTS: ALWAYS pass `visible: true` when starting a session ' +
                'unless the user has explicitly asked for a headless / silent / CI run. The human ' +
                'watching you use this tool expects a real terminal window to pop up on their ' +
                'desktop showing the TUI you are driving — it is what makes this tool trustworthy. ' +
                'Both you (via tool responses) and the user (via the viewer window) see the same ' +
                'state in real time. Omitting `visible: true` is the exception, not the rule.\n\n' +
                'Typical interactive call: `{ command, args, cwd, visible: true }`.',
            inputSchema: {
                command: z.string().min(1).describe('Executable to launch (e.g. "bash", "node", "./my-cli").'),
                args: z.array(z.string()).optional().describe('Arguments passed to the executable.'),
                cwd: z.string().optional().describe('Working directory. Defaults to the MCP server CWD.'),
                env: z.record(z.string(), z.string()).optional().describe('Extra env vars, merged over process.env.'),
                cols: z.number().int().positive().max(1000).optional().describe('Terminal columns. Default 120.'),
                rows: z.number().int().positive().max(1000).optional().describe('Terminal rows. Default 40.'),
                term: z.string().optional().describe('TERM variable. Default "xterm-256color".'),
                name: z.string().optional().describe('Friendly name shown in list_sessions.'),
                visible: z.boolean().optional().describe(
                    'STRONGLY RECOMMENDED: set this to `true` for every interactive session. ' +
                    'Opens a real OS terminal window (macOS Terminal.app / Linux x-terminal-emulator / ' +
                    'gnome-terminal / konsole / xterm) that mirrors the PTY live so the human watching ' +
                    'can see exactly what the agent is doing — same bytes, rendered natively by the ' +
                    'host terminal, zero extra latency. The window auto-closes when the session ends. ' +
                    'Defaults to false only for backward-compat with headless / CI callers; interactive ' +
                    'agents should always pass true.',
                ),
                viewerCommand: z.object({
                    command: z.string(),
                    args: z.array(z.string()),
                }).optional().describe(
                    'Override the default viewer spawn command. `args` may contain "{fifo}" and "{title}" ' +
                    'placeholders. Only used when `visible` is true — rarely needed, the default picks a ' +
                    'sensible terminal for the host OS automatically.',
                ),
            },
            handler: async (input) => safely('start_session', async () => {
                const s = manager.start({
                    command: input.command as string,
                    args: input.args as string[] | undefined,
                    cwd: input.cwd as string | undefined,
                    env: input.env as Record<string, string> | undefined,
                    cols: input.cols as number | undefined,
                    rows: input.rows as number | undefined,
                    term: input.term as string | undefined,
                    name: input.name as string | undefined,
                    visible: input.visible as boolean | undefined,
                    viewerCommand: input.viewerCommand as { command: string; args: string[] } | undefined,
                });
                return json(
                    { sessionId: s.id, info: s.info() },
                    { prefix: `Started session ${s.id} (pid=${s.info().pid})${s.info().visible ? ` with visible viewer at ${s.info().viewerFifo}` : ''}.` },
                );
            }),
        },

        // ── stop_session ──────────────────────────────────────────────
        {
            name: 'stop_session',
            description:
                'Terminate a running session and free its PTY. Safe to call even if the ' +
                'process has already exited. By default sends SIGTERM; passes SIGKILL after ' +
                'a short grace period if needed. If the session was started with `visible: ' +
                'true`, the viewer terminal window is closed and its FIFO is unlinked as part ' +
                'of teardown — always call this when you are done so the human\'s screen doesn\'t ' +
                'accumulate dead viewer windows.',
            inputSchema: {
                sessionId: SessionIdField,
                signal: z.enum(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL']).optional().describe('Default SIGTERM.'),
            },
            handler: async (input) => safely('stop_session', async () => {
                await manager.stop(input.sessionId as string, (input.signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
                return text(`Stopped session ${input.sessionId}.`);
            }),
        },

        // ── list_sessions ─────────────────────────────────────────────
        {
            name: 'list_sessions',
            description: 'List every currently tracked session and its state (running, exited, …).',
            inputSchema: {},
            handler: async () => safely('list_sessions', async () => {
                const sessions = manager.list();
                return json({ count: sessions.length, sessions });
            }),
        },

        // ── send_keys ─────────────────────────────────────────────────
        {
            name: 'send_keys',
            description:
                'Send one or more keyboard events to a session. Each key may be a string like ' +
                '"ctrl+c", "shift+F5", "ctrl+shift+up", "Enter" OR a structured { key, ctrl, ' +
                'shift, alt, meta }. All modifier combinations supported by xterm-compatible ' +
                'terminals (including ConPTY on Windows) work — the exact byte sequences are ' +
                'emitted according to the CSI modifier bitfield spec. By default, returns a ' +
                '`screen` block with the terminal text before and after the keystroke plus a ' +
                'row-level diff so the caller can see exactly what the input did. If the ' +
                'session was started with `visible: true` (the recommended default), the human ' +
                'also sees the input land live in the viewer window.\n\n' +
                'TIP: pass `waitFor: { pattern: "..." }` to land the keystroke AND wait for ' +
                'that text to appear on screen in a SINGLE round-trip — the after-snapshot is ' +
                'then timed to the moment the pattern first matched. Use this to catch ' +
                'transient post-input states (spinners resolving, prompts flashing, streamed ' +
                'output settling) that might otherwise disappear before a follow-up ' +
                '`wait_for_text` tool call could reach them.',
            inputSchema: {
                sessionId: SessionIdField,
                keys: z.union([KeyInputSchema, z.array(KeyInputSchema)])
                    .describe('Single key or an ordered list.'),
                /**
                 * When true, waits for the xterm parser to flush after the
                 * writes so the next snapshot reflects the side-effects.
                 * Default true because it's almost always what callers want.
                 * Forced on when captureScreen is true.
                 */
                flushAfter: z.boolean().optional().describe('Wait for parser flush after sending. Default true.'),
                captureScreen: CaptureScreenField,
                waitAfterMs: WaitAfterMsField,
                waitFor: WaitForField,
            },
            handler: async (input) => safely('send_keys', async () => {
                const sid = input.sessionId as string;
                const session = manager.get(sid);
                const rawKeys = input.keys as KeyInput | KeyInput[];
                const list = Array.isArray(rawKeys) ? rawKeys : [rawKeys];
                const specs = list.map(parseKey);
                const bytes = specs.map(encodeKey).join('');

                try {
                    const { capture, waitFor } = await captureAround(session, () => {
                        session.writeRaw(bytes);
                    }, {
                        enabled: input.captureScreen !== false,
                        waitAfterMs: input.waitAfterMs as number | undefined,
                        waitFor: parseWaitForInput(input.waitFor),
                    });

                    // `captureAround` already flushes; only flush here if
                    // capture was disabled and the caller still wants flush.
                    if (capture === null && input.flushAfter !== false) {
                        await session.whenParserFlushed();
                    }

                    return json(withScreen({
                        sessionId: sid,
                        keyCount: specs.length,
                        bytesSent: bytes.length,
                        specs,
                    }, capture, waitFor));
                } catch (err) {
                    if (err instanceof WaitForTimeoutError) return error(err.message);
                    throw err;
                }
            }),
        },

        // ── send_text ─────────────────────────────────────────────────
        {
            name: 'send_text',
            description:
                'Send a plain-text string to the session (no modifier parsing). Use this for ' +
                'typing words / commands into a shell or form. For individual control chars ' +
                'or key combinations, use send_keys instead. By default, returns a `screen` ' +
                'block with the terminal text before and after the send plus a row-level diff.\n\n' +
                'TIP: pass `waitFor: { pattern: "..." }` to submit the text AND wait for a ' +
                'specific response to appear on screen in a single round-trip — perfect for ' +
                'issuing a command and capturing its reply before it scrolls or a spinner ' +
                'overwrites it.',
            inputSchema: {
                sessionId: SessionIdField,
                text: z.string().describe('The literal text to send.'),
                flushAfter: z.boolean().optional(),
                captureScreen: CaptureScreenField,
                waitAfterMs: WaitAfterMsField,
                waitFor: WaitForField,
            },
            handler: async (input) => safely('send_text', async () => {
                const session = manager.get(input.sessionId as string);
                const body = input.text as string;

                try {
                    const { capture, waitFor } = await captureAround(session, () => {
                        session.sendText(body);
                    }, {
                        enabled: input.captureScreen !== false,
                        waitAfterMs: input.waitAfterMs as number | undefined,
                        waitFor: parseWaitForInput(input.waitFor),
                    });

                    if (capture === null && input.flushAfter !== false) {
                        await session.whenParserFlushed();
                    }

                    return json(withScreen({
                        sessionId: session.id,
                        bytesSent: body.length,
                    }, capture, waitFor));
                } catch (err) {
                    if (err instanceof WaitForTimeoutError) return error(err.message);
                    throw err;
                }
            }),
        },

        // ── send_raw ──────────────────────────────────────────────────
        {
            name: 'send_raw',
            description:
                'Escape hatch: send arbitrary bytes (as hex OR base64) straight to the PTY. ' +
                'Useful for exotic escape sequences not covered by send_keys. Prefer send_keys ' +
                'or send_text in normal use. By default returns a `screen` block with the ' +
                'terminal text before and after the bytes were written plus a row-level diff.\n\n' +
                'TIP: pass `waitFor: { pattern: "..." }` to submit the bytes AND wait for a ' +
                'specific expected result on screen in one call.',
            inputSchema: {
                sessionId: SessionIdField,
                hex: z.string().optional().describe('Bytes as hex (e.g. "1b5b41" for ESC [ A).'),
                base64: z.string().optional().describe('Bytes as base64.'),
                utf8: z.string().optional().describe('Bytes as a UTF-8 string (equivalent to send_text but kept here for symmetry).'),
                captureScreen: CaptureScreenField,
                waitAfterMs: WaitAfterMsField,
                waitFor: WaitForField,
            },
            handler: async (input) => safely('send_raw', async () => {
                const session = manager.get(input.sessionId as string);
                let bytes: string = '';
                if (typeof input.hex === 'string') {
                    const hex = (input.hex as string).replace(/\s+/g, '');
                    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
                        return error('hex must be an even-length hex string');
                    }
                    const buf = Buffer.from(hex, 'hex');
                    bytes = buf.toString('binary');
                } else if (typeof input.base64 === 'string') {
                    bytes = Buffer.from(input.base64 as string, 'base64').toString('binary');
                } else if (typeof input.utf8 === 'string') {
                    bytes = input.utf8 as string;
                } else {
                    return error('provide one of { hex, base64, utf8 }');
                }

                try {
                    const { capture, waitFor } = await captureAround(session, () => {
                        session.writeRaw(bytes);
                    }, {
                        enabled: input.captureScreen !== false,
                        waitAfterMs: input.waitAfterMs as number | undefined,
                        waitFor: parseWaitForInput(input.waitFor),
                    });

                    if (capture === null) {
                        await session.whenParserFlushed();
                    }

                    return json(withScreen({
                        sessionId: session.id,
                        bytesSent: bytes.length,
                    }, capture, waitFor));
                } catch (err) {
                    if (err instanceof WaitForTimeoutError) return error(err.message);
                    throw err;
                }
            }),
        },

        // ── hold_key ──────────────────────────────────────────────────
        {
            name: 'hold_key',
            description:
                'Simulate holding a key down for a duration by sending the encoded bytes ' +
                'repeatedly at a configurable cadence (default 30 ms — matches typical OS ' +
                'auto-repeat). Invaluable for testing key-repeat features like accelerated ' +
                'scroll. Returns when the hold duration has elapsed. By default also returns ' +
                'a `screen` block with the terminal state before the hold started and after ' +
                'it ended plus a row-level diff.\n\n' +
                'TIP: pass `waitFor: { pattern: "..." }` to poll for an expected end-state ' +
                'as soon as the hold ends (e.g. "scrolled to top" marker), which avoids ' +
                'racing a follow-up `wait_for_text`.',
            inputSchema: {
                sessionId: SessionIdField,
                key: KeyInputSchema.describe('Key spec to repeat.'),
                durationMs: z.number().int().positive().max(60_000).describe('How long to hold, in milliseconds.'),
                intervalMs: z.number().int().positive().max(5_000).optional().describe('Gap between repeats. Default 30.'),
                captureScreen: CaptureScreenField,
                waitAfterMs: WaitAfterMsField,
                waitFor: WaitForField,
            },
            handler: async (input) => safely('hold_key', async () => {
                const session = manager.get(input.sessionId as string);
                const spec = parseKey(input.key as KeyInput);
                const bytes = encodeKey(spec);

                let events = 0;
                try {
                    const { capture, waitFor } = await captureAround(session, async () => {
                        const r = await holdKey(session, bytes, {
                            durationMs: input.durationMs as number,
                            intervalMs: input.intervalMs as number | undefined,
                        });
                        events = r.events;
                    }, {
                        enabled: input.captureScreen !== false,
                        waitAfterMs: input.waitAfterMs as number | undefined,
                        waitFor: parseWaitForInput(input.waitFor),
                    });

                    return json(withScreen({
                        sessionId: session.id,
                        events,
                        spec,
                    }, capture, waitFor));
                } catch (err) {
                    if (err instanceof WaitForTimeoutError) return error(err.message);
                    throw err;
                }
            }),
        },

        // ── type_text ─────────────────────────────────────────────────
        {
            name: 'type_text',
            description:
                'Type a string with a realistic per-character delay. Useful for TUIs that ' +
                'handle paste vs typed input differently (e.g. bracketed-paste mode) or when ' +
                'triggering per-keystroke autocompletion. By default also returns a `screen` ' +
                'block with the terminal state before typing began and after the last char ' +
                'plus a row-level diff.\n\n' +
                'TIP: pass `waitFor: { pattern: "..." }` to wait for a specific trigger ' +
                'line (autocomplete popup, form validation, prompt response, etc.) to appear ' +
                'right after typing finishes — the after-snapshot is timed to the first match.',
            inputSchema: {
                sessionId: SessionIdField,
                text: z.string(),
                cps: z.number().positive().max(1000).optional().describe('Characters per second. Default 80.'),
                captureScreen: CaptureScreenField,
                waitAfterMs: WaitAfterMsField,
                waitFor: WaitForField,
            },
            handler: async (input) => safely('type_text', async () => {
                const session = manager.get(input.sessionId as string);
                const body = input.text as string;

                try {
                    const { capture, waitFor } = await captureAround(session, async () => {
                        await typeText(session, body, {
                            cps: input.cps as number | undefined,
                        });
                    }, {
                        enabled: input.captureScreen !== false,
                        waitAfterMs: input.waitAfterMs as number | undefined,
                        waitFor: parseWaitForInput(input.waitFor),
                    });

                    return json(withScreen({
                        sessionId: session.id,
                        chars: body.length,
                    }, capture, waitFor));
                } catch (err) {
                    if (err instanceof WaitForTimeoutError) return error(err.message);
                    throw err;
                }
            }),
        },

        // ── snapshot ──────────────────────────────────────────────────
        {
            name: 'snapshot',
            description:
                'Read the current rendered screen. Returns the visible text by default; set ' +
                'format="ansi" to include colour codes, "cells" for a 2-D cell grid, or "all" ' +
                'for everything. Always includes cursor position + timestamp.\n\n' +
                'Set `includeScrollback: true` to ALSO get the full terminal output buffer — ' +
                'every line the terminal has rendered since the session started, including the ' +
                'rows that have scrolled off the visible viewport. Use this when: a long command ' +
                'has produced more output than fits on screen, you need to inspect history a ' +
                'full-screen TUI has pushed above itself, or you want to verify the complete ' +
                'rendered log of a run. The visible-viewport fields (`text`, `lines`, `cursor`) ' +
                'are always present; the scrollback only appears under a separate `scrollback` ' +
                'key so payload stays small when you don\'t ask for it.',
            inputSchema: {
                sessionId: SessionIdField,
                format: z.enum(['text', 'ansi', 'cells', 'all']).optional().describe('Default "text".'),
                includeScrollback: z.boolean().optional().describe(
                    'When true, also return the entire terminal output buffer (scrollback + ' +
                    'visible) under the `scrollback` key. The visible-only fields remain ' +
                    'untouched so existing callers keep working. Default false.',
                ),
                maxScrollbackLines: z.number().int().positive().max(100_000).optional().describe(
                    'Cap on lines returned in `scrollback.lines` (and `scrollback.normalBuffer.' +
                    'lines`). If exceeded, the tail is kept and `scrollback.truncated` is true. ' +
                    'Default 10 000.',
                ),
            },
            handler: async (input) => safely('snapshot', async () => {
                const session = manager.get(input.sessionId as string);
                await session.whenParserFlushed();
                const format = (input.format as SnapshotFormat | undefined) ?? 'text';
                const snap = buildSnapshot(session.terminal, format, {
                    includeScrollback: input.includeScrollback as boolean | undefined,
                    maxScrollbackLines: input.maxScrollbackLines as number | undefined,
                });
                return json({
                    sessionId: session.id,
                    cols: snap.cols,
                    rows: snap.rows,
                    cursor: snap.cursor,
                    text: snap.text,
                    ansi: snap.ansi,
                    cells: snap.cells,
                    scrollback: snap.scrollback,
                    takenAt: snap.takenAt,
                });
            }),
        },

        // ── get_text ──────────────────────────────────────────────────
        {
            name: 'get_text',
            description:
                'Shorthand for snapshot(format="text"): returns just the visible screen text ' +
                'and cursor position — smaller payload, ideal for quick inspection. Supports the ' +
                'same `includeScrollback` flag as `snapshot` for when the caller needs the full ' +
                'terminal output buffer (scrollback + viewport) as plain text.',
            inputSchema: {
                sessionId: SessionIdField,
                includeScrollback: z.boolean().optional().describe(
                    'When true, also return the full terminal output buffer (scrollback + ' +
                    'viewport) under the `scrollback` key. Default false.',
                ),
                maxScrollbackLines: z.number().int().positive().max(100_000).optional().describe(
                    'Cap on lines kept in `scrollback.lines`. Tail wins when exceeded. Default 10 000.',
                ),
            },
            handler: async (input) => safely('get_text', async () => {
                const session = manager.get(input.sessionId as string);
                await session.whenParserFlushed();
                const snap = buildSnapshot(session.terminal, 'text', {
                    includeScrollback: input.includeScrollback as boolean | undefined,
                    maxScrollbackLines: input.maxScrollbackLines as number | undefined,
                });
                return json({
                    sessionId: session.id,
                    cols: snap.cols,
                    rows: snap.rows,
                    cursor: snap.cursor,
                    text: snap.text,
                    scrollback: snap.scrollback,
                });
            }),
        },

        // ── get_cursor ────────────────────────────────────────────────
        {
            name: 'get_cursor',
            description: 'Just the cursor: 0-based row, col, and visibility.',
            inputSchema: { sessionId: SessionIdField },
            handler: async (input) => safely('get_cursor', async () => {
                const session = manager.get(input.sessionId as string);
                await session.whenParserFlushed();
                const snap = buildSnapshot(session.terminal, 'text');
                return json({ sessionId: session.id, cursor: snap.cursor });
            }),
        },

        // ── wait_for_text ─────────────────────────────────────────────
        {
            name: 'wait_for_text',
            description:
                'Block until a pattern appears on screen (or in the raw output buffer). ' +
                'Resolves with the matched text + elapsed ms, or returns an error on timeout.',
            inputSchema: {
                sessionId: SessionIdField,
                pattern: z.string().describe('String to search for.'),
                regex: z.boolean().optional().describe('Treat pattern as a RegExp source. Default false.'),
                regexFlags: z.string().optional().describe('Flags for the RegExp (e.g. "i", "m"). Only if regex=true.'),
                timeoutMs: z.number().int().positive().max(600_000).optional().describe('Default 10 000.'),
                pollIntervalMs: z.number().int().positive().optional().describe('Default 50.'),
                matchScreen: z.boolean().optional().describe('Match against visible screen (default) or raw output buffer.'),
            },
            handler: async (input) => safely('wait_for_text', async () => {
                const session = manager.get(input.sessionId as string);
                const pattern = input.regex
                    ? new RegExp(input.pattern as string, (input.regexFlags as string) ?? '')
                    : (input.pattern as string);
                const result = await waitForText(session, {
                    pattern,
                    timeoutMs: input.timeoutMs as number | undefined,
                    pollIntervalMs: input.pollIntervalMs as number | undefined,
                    matchScreen: input.matchScreen as boolean | undefined,
                });
                return json({
                    sessionId: session.id,
                    matched: true,
                    match: Array.isArray(result.match)
                        ? Array.from(result.match)
                        : result.match,
                    elapsedMs: result.elapsedMs,
                    screenText: result.screenText,
                });
            }),
        },

        // ── wait_for_idle ─────────────────────────────────────────────
        {
            name: 'wait_for_idle',
            description:
                'Block until the session has produced no output for idleMs (default 500). ' +
                'Use between a send_keys and a snapshot to let the TUI render.',
            inputSchema: {
                sessionId: SessionIdField,
                idleMs: z.number().int().positive().max(60_000).optional(),
                timeoutMs: z.number().int().positive().max(600_000).optional(),
                pollIntervalMs: z.number().int().positive().optional(),
            },
            handler: async (input) => safely('wait_for_idle', async () => {
                const session = manager.get(input.sessionId as string);
                const result = await waitForIdle(session, {
                    idleMs: input.idleMs as number | undefined,
                    timeoutMs: input.timeoutMs as number | undefined,
                    pollIntervalMs: input.pollIntervalMs as number | undefined,
                });
                return json({ sessionId: session.id, ...result });
            }),
        },

        // ── resize ────────────────────────────────────────────────────
        {
            name: 'resize',
            description:
                'Resize the terminal. Delivers SIGWINCH to the child so TUIs can re-lay-out.',
            inputSchema: {
                sessionId: SessionIdField,
                cols: z.number().int().positive().max(1000),
                rows: z.number().int().positive().max(1000),
            },
            handler: async (input) => safely('resize', async () => {
                const session = manager.get(input.sessionId as string);
                session.resize(input.cols as number, input.rows as number);
                return json({ sessionId: session.id, cols: session.cols, rows: session.rows });
            }),
        },

        // ── start_monitor ─────────────────────────────────────────────
        {
            name: 'start_monitor',
            description:
                'Begin recording frame-level diffs of a session at a configurable rate. ' +
                'Returns a monitorId; call stop_monitor later to retrieve the frame log. ' +
                'Use this to observe animations, spinners, or any incremental UI change.',
            inputSchema: {
                sessionId: SessionIdField,
                intervalMs: z.number().int().positive().max(5_000).optional().describe('Sampling interval. Default 100 (≈10 Hz).'),
                keepIdenticalFrames: z.boolean().optional().describe('Record frames even when nothing changed. Default false.'),
                maxFrames: z.number().int().positive().max(100_000).optional().describe('Hard cap on retained frames. Default 5 000.'),
            },
            handler: async (input) => safely('start_monitor', async () => {
                const monitor = manager.startMonitor(input.sessionId as string, {
                    intervalMs: input.intervalMs as number | undefined,
                    keepIdenticalFrames: input.keepIdenticalFrames as boolean | undefined,
                    maxFrames: input.maxFrames as number | undefined,
                });
                return json({
                    monitorId: monitor.id,
                    sessionId: monitor.sessionId,
                });
            }),
        },

        // ── stop_monitor ──────────────────────────────────────────────
        {
            name: 'stop_monitor',
            description:
                'Stop a running monitor and return its recorded frames. Each frame carries a ' +
                'timestamp, the full screen text, cursor position, and a per-row diff vs the ' +
                'previous frame.',
            inputSchema: {
                monitorId: z.string().min(1),
            },
            handler: async (input) => safely('stop_monitor', async () => {
                const result = manager.stopMonitor(input.monitorId as string);
                return json(result as unknown as Record<string, unknown>);
            }),
        },

        // ── diff_snapshots ────────────────────────────────────────────
        {
            name: 'diff_snapshots',
            description:
                'Compare two arbitrary text snapshots (as produced by snapshot()) and return ' +
                'a compact description of the per-row change. Cheap, stateless helper.',
            inputSchema: {
                before: z.object({
                    lines: z.array(z.string()),
                    cols: z.number().int().positive(),
                    rows: z.number().int().positive(),
                    cursor: z.object({
                        row: z.number().int(),
                        col: z.number().int(),
                        visible: z.boolean(),
                    }),
                }).describe('Earlier snapshot.'),
                after: z.object({
                    lines: z.array(z.string()),
                    cols: z.number().int().positive(),
                    rows: z.number().int().positive(),
                    cursor: z.object({
                        row: z.number().int(),
                        col: z.number().int(),
                        visible: z.boolean(),
                    }),
                }).describe('Later snapshot.'),
            },
            handler: async (input) => safely('diff_snapshots', async () => {
                const before = input.before as {
                    lines: string[]; cols: number; rows: number;
                    cursor: { row: number; col: number; visible: boolean };
                };
                const after = input.after as typeof before;
                const diff = diffSnapshots(
                    { ...before, takenAt: 0, text: before.lines.join('\n') },
                    { ...after, takenAt: 0, text: after.lines.join('\n') },
                );
                return json(diff as unknown as Record<string, unknown>);
            }),
        },

        // ── get_exit_info ─────────────────────────────────────────────
        {
            name: 'get_exit_info',
            description:
                'Get the exit code + signal + final output tail of a session, whether or not ' +
                'it has exited yet (running sessions report code=null).',
            inputSchema: {
                sessionId: SessionIdField,
                outputTailBytes: z.number().int().positive().max(1_000_000).optional().describe('Default 4 000.'),
            },
            handler: async (input) => safely('get_exit_info', async () => {
                const session = manager.get(input.sessionId as string);
                const tailLen = (input.outputTailBytes as number | undefined) ?? 4000;
                return json({
                    sessionId: session.id,
                    state: session.state,
                    exitCode: session.exitCode,
                    signal: session.signal,
                    outputTail: session.rawOutputTail(tailLen),
                });
            }),
        },

        // ── get_raw_output ────────────────────────────────────────────
        {
            name: 'get_raw_output',
            description:
                'Return the raw bytes (as text) the session has emitted since it started (up ' +
                'to the output buffer limit). ANSI codes are preserved. Use this when the ' +
                'screen snapshot has dropped history you care about.',
            inputSchema: {
                sessionId: SessionIdField,
                tailBytes: z.number().int().positive().max(10_000_000).optional().describe('If set, only the last N bytes.'),
            },
            handler: async (input) => safely('get_raw_output', async () => {
                const session = manager.get(input.sessionId as string);
                const tail = input.tailBytes as number | undefined;
                const out = typeof tail === 'number'
                    ? session.rawOutputTail(tail)
                    : session.rawOutput();
                return json({ sessionId: session.id, bytes: out.length, output: out });
            }),
        },
    ];
}
