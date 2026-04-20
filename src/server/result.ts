/**
 * Helpers for building MCP tool results.  The MCP protocol expects a
 * result object shaped like `{ content: [{ type: 'text', text }, …] }`
 * with an optional `isError: true` flag when something went wrong.
 */

export interface ToolResultContent {
    type: 'text';
    text: string;
}

export interface ToolResult {
    content: ToolResultContent[];
    isError?: boolean;
    /**
     * Optional structured data echoed back to the caller.  MCP clients
     * that support `structuredContent` (newer protocol versions) will
     * surface this to the model as JSON; older clients ignore it.  We
     * always also stringify it into the `content` array as a safety net.
     */
    structuredContent?: Record<string, unknown>;
}

/** Build a simple text result. */
export function text(msg: string): ToolResult {
    return { content: [{ type: 'text', text: msg }] };
}

/**
 * Build a result that carries structured JSON.  The JSON is pretty-
 * printed into the `content` array (so the model can read it even on
 * clients that ignore `structuredContent`) and also attached to
 * `structuredContent` for clients that surface it natively.
 */
export function json(data: Record<string, unknown>, options: { prefix?: string } = {}): ToolResult {
    const prefix = options.prefix ? `${options.prefix}\n` : '';
    return {
        content: [{ type: 'text', text: prefix + JSON.stringify(data, null, 2) }],
        structuredContent: data,
    };
}

/** Build an error result. */
export function error(message: string, detail?: Record<string, unknown>): ToolResult {
    const detailText = detail ? '\n' + JSON.stringify(detail, null, 2) : '';
    return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${message}${detailText}` }],
        structuredContent: detail ? { error: message, ...detail } : { error: message },
    };
}

/**
 * Wraps a tool handler so any thrown error becomes an `isError: true`
 * result instead of a protocol-level crash.  This is what MCP clients
 * expect for domain errors (session-not-found, timeout, etc.).
 */
export async function safely<T>(
    name: string,
    fn: () => Promise<ToolResult> | ToolResult,
): Promise<ToolResult> {
    try {
        return await fn();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorName = err instanceof Error ? err.name : 'Error';
        return error(`[${name}] ${errorName}: ${message}`);
    }
}
