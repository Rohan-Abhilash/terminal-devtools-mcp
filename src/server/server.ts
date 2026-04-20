/**
 * Assemble an McpServer, register every tool, and wire shutdown so we
 * never leak PTY processes.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { SessionManager } from '../session/session-manager.js';
import { buildTools } from './tools.js';

export interface BuildServerOptions {
    name?: string;
    version?: string;
    maxSessions?: number;
    maxMonitors?: number;
}

export interface BuiltServer {
    mcp: McpServer;
    manager: SessionManager;
    /** Kills every session and monitor.  Call before process exit. */
    shutdown: () => Promise<void>;
}

export function buildServer(opts: BuildServerOptions = {}): BuiltServer {
    const manager = new SessionManager({
        maxSessions: opts.maxSessions,
        maxMonitors: opts.maxMonitors,
    });

    const mcp = new McpServer(
        {
            name: opts.name ?? 'tui-tester',
            version: opts.version ?? '0.1.0',
        },
        {
            // Advertise the tools capability.
            capabilities: {
                tools: {},
            },
        },
    );

    const tools = buildTools(manager);
    for (const tool of tools) {
        mcp.registerTool(
            tool.name,
            {
                description: tool.description,
                inputSchema: tool.inputSchema,
            },
            // The SDK validates against the inputSchema and passes typed args.
            // We accept unknown-shape since every handler unpacks defensively.
            async (args: unknown) => {
                const result = await tool.handler((args ?? {}) as Record<string, unknown>);
                return result as unknown as {
                    content: Array<{ type: 'text'; text: string }>;
                    isError?: boolean;
                    structuredContent?: Record<string, unknown>;
                };
            },
        );
    }

    const shutdown = async (): Promise<void> => {
        await manager.shutdown();
        try { await mcp.close(); } catch { /* already closed */ }
    };

    return { mcp, manager, shutdown };
}
