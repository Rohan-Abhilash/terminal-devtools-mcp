/**
 * Tests for VisibleViewer.
 *
 * We test FIFO mechanics end-to-end WITHOUT spawning a real terminal
 * window (we'd have no way to assert against what the user sees on
 * their screen, and CI would fail).  Instead we use a custom
 * `viewerCommand` that spawns a simple shell reader (`cat <fifo>` into
 * a file we own) so the test can verify the bytes we wrote came back
 * out the other side.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VisibleViewer } from '../../src/session/viewer.js';

let viewers: VisibleViewer[] = [];
let tempOutputs: string[] = [];

afterEach(() => {
    for (const v of viewers) {
        try { v.stop(); } catch { /* no-op */ }
    }
    viewers = [];
    for (const f of tempOutputs) {
        try { fs.unlinkSync(f); } catch { /* no-op */ }
    }
    tempOutputs = [];
});

function track(v: VisibleViewer): VisibleViewer {
    viewers.push(v);
    return v;
}

/** Spawn a background cat that writes the FIFO contents to a temp file. */
function readerCommand(outPath: string): { command: string; args: string[] } {
    tempOutputs.push(outPath);
    return {
        command: 'bash',
        args: ['-c', `cat "{fifo}" > "${outPath}" 2>/dev/null &`],
    };
}

describe('VisibleViewer — FIFO mechanics', () => {
    it('creates a FIFO at the configured path', () => {
        const sid = 'test-mech-' + Date.now();
        const v = track(new VisibleViewer(sid, { title: 'test' }));
        // Don't spawn a real viewer — just pass an empty override that
        // does nothing measurable in the test.  (A no-op fallback still
        // creates the FIFO.)
        v.start({ command: 'true', args: [] });
        expect(fs.existsSync(v.fifoPath)).toBe(true);
        // FIFO should have the "pipe" file type.
        const stat = fs.statSync(v.fifoPath);
        expect(stat.isFIFO()).toBe(true);
    });

    it('writes bytes that a reader can pick up', async () => {
        const sid = 'test-write-' + Date.now();
        const outPath = path.join(os.tmpdir(), `tui-tester-test-out-${sid}.log`);
        const v = track(new VisibleViewer(sid, { title: 'test' }));
        v.start(readerCommand(outPath));
        // Give the reader a tick to open the FIFO.
        await new Promise((r) => setTimeout(r, 100));
        v.write('hello-from-viewer\n');
        v.write('second-line\n');
        // Give the reader another tick to flush.
        await new Promise((r) => setTimeout(r, 200));

        // The reader wrote bytes to `outPath`; verify contents.
        const got = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8') : '';
        expect(got).toContain('hello-from-viewer');
        expect(got).toContain('second-line');
    });

    it('annotate() writes a formatted line without throwing', () => {
        const sid = 'test-annot-' + Date.now();
        const v = track(new VisibleViewer(sid, { title: 'test' }));
        v.start({ command: 'true', args: [] });
        expect(() => v.annotate('hello annotation')).not.toThrow();
    });

    it('stop() closes the fd and unlinks the FIFO', () => {
        const sid = 'test-stop-' + Date.now();
        const v = track(new VisibleViewer(sid, { title: 'test' }));
        v.start({ command: 'true', args: [] });
        expect(fs.existsSync(v.fifoPath)).toBe(true);
        v.stop();
        expect(fs.existsSync(v.fifoPath)).toBe(false);
        // A write after stop() is a no-op (doesn't throw).
        expect(() => v.write('ignored')).not.toThrow();
    });

    it('stop() is idempotent', () => {
        const sid = 'test-idem-' + Date.now();
        const v = track(new VisibleViewer(sid, { title: 'test' }));
        v.start({ command: 'true', args: [] });
        v.stop();
        expect(() => v.stop()).not.toThrow();
    });

    it('write() silently drops after EPIPE (reader went away)', async () => {
        // Without any command at all we get the FIFO but no reader — any
        // attempt to write should safely no-op (Node's fs.writeSync in
        // O_NONBLOCK mode returns EAGAIN in that case, which is also
        // treated as drop-chunk).  We just need to assert no throw.
        const sid = 'test-no-reader-' + Date.now();
        const v = track(new VisibleViewer(sid, { title: 'test' }));
        v.start({ command: 'true', args: [] });
        for (let i = 0; i < 100; i += 1) {
            expect(() => v.write('x')).not.toThrow();
        }
    });
});
