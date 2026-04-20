/**
 * End-to-end test against the bundled `scripts/demo-tui.mjs` TUI.
 *
 * This exercises the whole pipeline (spawn → PTY → xterm emulator →
 * snapshot → send keys → observe diff) against a real interactive TUI
 * that uses:
 *   - the alternate screen buffer,
 *   - raw-mode stdin,
 *   - absolute-positioned ANSI drawing,
 * which is exactly what real-world curses/ratatui/ink/bubbletea apps do.
 *
 * Everything ships inside this repository, so the test runs on every
 * clean clone without any external dependency.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { SessionManager } from '../../src/session/session-manager.js';
import { waitForText } from '../../src/session/wait.js';
import { buildSnapshot } from '../../src/snapshot/snapshot.js';

// Resolve the demo TUI relative to the package root. process.cwd() is
// stable across ts-jest's CJS mode and Node's ESM loader.
const DEMO_TUI_PATH = path.resolve(process.cwd(), 'scripts', 'demo-tui.mjs');

if (!fs.existsSync(DEMO_TUI_PATH)) {
    throw new Error(`demo TUI script missing at ${DEMO_TUI_PATH}`);
}

let managers: SessionManager[] = [];
afterEach(async () => {
    await Promise.all(managers.map((m) => m.shutdown()));
    managers = [];
});

function newManager(): SessionManager {
    const m = new SessionManager();
    managers.push(m);
    return m;
}

describe('demo-tui e2e', () => {
    it('spawns the demo TUI and observes its first rendered frame', async () => {
        const manager = newManager();
        const session = manager.start({
            command: 'node',
            args: [DEMO_TUI_PATH],
            cols: 80,
            rows: 24,
        });

        // Wait for the TUI to finish its first frame — it always ends
        // with the literal "READY" on row 11.
        const matched = await waitForText(session, {
            pattern: 'READY',
            timeoutMs: 5000,
        });
        expect(matched.matched).toBe(true);

        // Snapshot the visible screen and check for the expected banner
        // and initial counter state.
        const snap = buildSnapshot(session.terminal, 'text');
        expect(snap.text).toContain('tui-tester demo TUI');
        expect(snap.text).toContain('Counter : 0');
        expect(snap.text).toContain('Last key: <none>');

        await manager.stop(session.id, 'SIGKILL');
    });

    it('drives the TUI with arrow keys and observes the counter change', async () => {
        const manager = newManager();
        const session = manager.start({
            command: 'node',
            args: [DEMO_TUI_PATH],
            cols: 80,
            rows: 24,
        });

        await waitForText(session, { pattern: 'READY', timeoutMs: 5000 });

        // Send ArrowUp three times (counter should become 3).
        for (let i = 0; i < 3; i += 1) {
            session.sendKeys(['up']);
            // Small gap so the TUI re-renders between presses.
            await new Promise((r) => setTimeout(r, 40));
        }
        await session.whenParserFlushed();
        await new Promise((r) => setTimeout(r, 100));

        const snap = buildSnapshot(session.terminal, 'text');
        expect(snap.text).toContain('Counter : 3');
        expect(snap.text).toContain('Last key: ArrowUp');

        // ArrowRight adds 10 → 13.
        session.sendKeys(['right']);
        await session.whenParserFlushed();
        await new Promise((r) => setTimeout(r, 100));

        const afterRight = buildSnapshot(session.terminal, 'text');
        expect(afterRight.text).toContain('Counter : 13');
        expect(afterRight.text).toContain('Last key: ArrowRight');

        // ArrowLeft resets to 0.
        session.sendKeys(['left']);
        await session.whenParserFlushed();
        await new Promise((r) => setTimeout(r, 100));

        const afterLeft = buildSnapshot(session.terminal, 'text');
        expect(afterLeft.text).toContain('Counter : 0');
        expect(afterLeft.text).toContain('Last key: ArrowLeft');

        await manager.stop(session.id, 'SIGKILL');
    });

    it('exits cleanly on q', async () => {
        const manager = newManager();
        const session = manager.start({
            command: 'node',
            args: [DEMO_TUI_PATH],
            cols: 80,
            rows: 24,
        });

        await waitForText(session, { pattern: 'READY', timeoutMs: 5000 });

        const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
            session.onExit((info) => resolve(info));
        });
        session.sendText('q');

        const info = await Promise.race([
            exited,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('demo TUI did not exit within 3s of receiving q')), 3000),
            ),
        ]);
        expect(info.code).toBe(0);
    });
});
