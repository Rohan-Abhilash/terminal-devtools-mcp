#!/usr/bin/env node
/**
 * Live demo: spawn a fresh instance of the tui-tester MCP server, ask
 * it to launch the bundled `demo-tui.mjs` TUI with `visible: true`,
 * and then drive a few arrow-key presses and a quit — all while the
 * user watches the real Terminal.app (macOS) / xterm (Linux) window
 * mirror the PTY in real time.
 *
 * Prereq: run `npm run build` first so `dist/index.js` exists.
 *
 * Usage:
 *     npm run build && node scripts/demo-visible.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'dist', 'index.js');
const DEMO_TUI = path.resolve(HERE, 'demo-tui.mjs');

if (!fs.existsSync(SERVER)) {
    console.error(`MCP server bundle not found at ${SERVER}`);
    console.error('Run `npm run build` first.');
    process.exit(1);
}
if (!fs.existsSync(DEMO_TUI)) {
    console.error(`Demo TUI not found at ${DEMO_TUI}`);
    process.exit(1);
}

// ── Spawn server (stdio transport) ──────────────────────────────────
const server = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
});
const rl = readline.createInterface({ input: server.stdout });

let id = 0;
const pending = new Map();

rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
    }
});

function rpc(method, params) {
    const myId = ++id;
    const payload = { jsonrpc: '2.0', id: myId, method, params };
    server.stdin.write(JSON.stringify(payload) + '\n');
    return new Promise((resolve, reject) => pending.set(myId, { resolve, reject }));
}

function notify(method, params) {
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function call(name, args) {
    return rpc('tools/call', { name, arguments: args });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

try {
    console.log('• initialize…');
    await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'tui-tester-demo', version: '0.0.0' },
    });
    notify('notifications/initialized', {});

    console.log('• start_session (visible: true) — a terminal window should pop up…');
    const startResult = await call('start_session', {
        command: 'node',
        args: [DEMO_TUI],
        cols: 100,
        rows: 30,
        name: 'visible-demo',
        visible: true,
    });
    const info = startResult.structuredContent.info;
    console.log('  → session', info.id, 'pid', info.pid);
    console.log('  → visible =', info.visible, ', FIFO =', info.viewerFifo);

    console.log('• wait 2s for the TUI to finish booting + for you to see it…');
    await sleep(2000);

    console.log('• send ArrowUp x5 (counter -> 5)…');
    for (let i = 0; i < 5; i += 1) {
        await call('send_keys', { sessionId: info.id, keys: 'up' });
        await sleep(300);
    }

    console.log('• send ArrowRight x3 (counter -> 35)…');
    for (let i = 0; i < 3; i += 1) {
        await call('send_keys', { sessionId: info.id, keys: 'right' });
        await sleep(400);
    }

    console.log('• send "r" (randomise)…');
    await call('send_text', { sessionId: info.id, text: 'r' });
    await sleep(800);

    console.log('• send ArrowLeft (reset to 0)…');
    await call('send_keys', { sessionId: info.id, keys: 'left' });
    await sleep(800);

    console.log('• wait another 2s so the user can see the final state…');
    await sleep(2000);

    console.log('• send q to exit the TUI gracefully…');
    await call('send_text', { sessionId: info.id, text: 'q' });
    await sleep(800);

    console.log('• stop_session (terminal window should close automatically)…');
    await call('stop_session', { sessionId: info.id, signal: 'SIGKILL' });

    console.log('\nDone.  If you watched the terminal window, you saw:');
    console.log('   1. the demo TUI boot and render its banner + counter');
    console.log('   2. the counter increment, jump, randomise, and reset');
    console.log('   3. the window close cleanly');
} catch (err) {
    console.error('demo failed:', err);
    process.exitCode = 1;
} finally {
    server.stdin.end();
    server.kill();
}
