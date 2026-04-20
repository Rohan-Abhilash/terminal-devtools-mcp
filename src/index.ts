/**
 * tui-tester — MCP server entrypoint.
 *
 * Runs over stdio (the standard MCP transport).  Parses a couple of
 * optional env vars / CLI flags for configuration, then connects and
 * hands control to the SDK's dispatcher.
 *
 * On SIGINT / SIGTERM we gracefully shut down every live PTY session
 * before exiting so we never leak child processes.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server/server.js';

function parseIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
    const { mcp, shutdown } = buildServer({
        maxSessions: parseIntEnv('TUI_TESTER_MAX_SESSIONS', 32),
        maxMonitors: parseIntEnv('TUI_TESTER_MAX_MONITORS', 16),
    });

    let shuttingDown = false;
    const gracefulExit = async (code: number) => {
        if (shuttingDown) return;
        shuttingDown = true;
        try { await shutdown(); } catch { /* swallow */ }
        process.exit(code);
    };

    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.on(sig, () => void gracefulExit(0));
    }
    process.on('uncaughtException', (err) => {
        process.stderr.write(`[tui-tester] uncaughtException: ${String(err)}\n`);
        void gracefulExit(1);
    });
    process.on('unhandledRejection', (err) => {
        process.stderr.write(`[tui-tester] unhandledRejection: ${String(err)}\n`);
        // Don't exit on unhandled rejections — they're almost always in
        // user-triggered tool handlers and we want the server to keep
        // serving other requests.
    });

    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    // McpServer keeps the process alive via the transport; we just wait.
}

main().catch((err) => {
    process.stderr.write(`[tui-tester] fatal: ${String(err)}\n`);
    process.exit(1);
});
