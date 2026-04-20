import { afterEach, describe, expect, it } from '@jest/globals';
import {
    SessionLimitError,
    SessionManager,
    SessionNotFoundError,
    MonitorNotFoundError,
} from '../../src/session/session-manager.js';

let managers: SessionManager[] = [];

afterEach(async () => {
    await Promise.all(managers.map((m) => m.shutdown()));
    managers = [];
});

function mk(opts?: ConstructorParameters<typeof SessionManager>[0]): SessionManager {
    const m = new SessionManager(opts);
    managers.push(m);
    return m;
}

describe('SessionManager', () => {
    it('tracks and looks up running sessions by id', async () => {
        const m = mk();
        const s = m.start({ command: 'bash', args: ['-c', 'sleep 0.2'] });
        expect(m.has(s.id)).toBe(true);
        expect(m.get(s.id)).toBe(s);
        expect(m.list()).toHaveLength(1);
    });

    it('throws SessionNotFoundError for unknown ids', () => {
        const m = mk();
        expect(() => m.get('nope')).toThrow(SessionNotFoundError);
    });

    it('enforces maxSessions', () => {
        const m = mk({ maxSessions: 2 });
        m.start({ command: 'bash', args: ['-c', 'sleep 0.5'] });
        m.start({ command: 'bash', args: ['-c', 'sleep 0.5'] });
        expect(() => m.start({ command: 'bash', args: ['-c', 'sleep 0.5'] })).toThrow(SessionLimitError);
    });

    it('drops sessions from the registry after stop()', async () => {
        const m = mk();
        const s = m.start({ command: 'bash', args: ['-c', 'sleep 5'] });
        await m.stop(s.id, 'SIGKILL');
        expect(m.has(s.id)).toBe(false);
    });

    it('starts and stops monitors, cleans up on session stop', async () => {
        const m = mk();
        const s = m.start({ command: 'bash', args: ['-c', 'sleep 1'] });
        const mon = m.startMonitor(s.id, { intervalMs: 50 });
        expect(m.listMonitors()).toHaveLength(1);
        // Stopping the session should drop its monitors too.
        await m.stop(s.id, 'SIGKILL');
        expect(m.listMonitors()).toHaveLength(0);
        // stopMonitor on the (already-dropped) id throws.
        expect(() => m.stopMonitor(mon.id)).toThrow(MonitorNotFoundError);
    });

    it('shutdown kills every session and monitor', async () => {
        const m = mk();
        m.start({ command: 'bash', args: ['-c', 'sleep 5'] });
        m.start({ command: 'bash', args: ['-c', 'sleep 5'] });
        await m.shutdown();
        expect(m.list()).toHaveLength(0);
        expect(m.listMonitors()).toHaveLength(0);
    });
});
