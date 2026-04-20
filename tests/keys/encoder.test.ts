import { describe, expect, it } from '@jest/globals';
import {
    encodeKey,
    encodeKeys,
    encodeText,
    KeyEncodeError,
    modifierParam,
} from '../../src/keys/encoder.js';
import { parseKey } from '../../src/keys/parser.js';

/** Convenience: parse then encode in one step for legibility. */
function enc(input: string): string {
    return encodeKey(parseKey(input));
}

/** Convert a string to an escape-visible ASCII form for readable asserts. */
function visible(s: string): string {
    return Array.from(s)
        .map((ch) => {
            const c = ch.charCodeAt(0);
            if (ch === '\x1b') return '\\e';
            if (c < 0x20) return `\\x${c.toString(16).padStart(2, '0')}`;
            if (c === 0x7f) return '\\x7f';
            return ch;
        })
        .join('');
}

describe('modifierParam — xterm CSI modifier parameter', () => {
    it('returns 1 for no modifiers', () => {
        expect(modifierParam({ key: 'x' })).toBe(1);
    });

    it('matches the canonical xterm bitfield', () => {
        // mod = 1 + shift + 2·alt + 4·ctrl + 8·meta
        expect(modifierParam({ key: 'x', shift: true })).toBe(2);
        expect(modifierParam({ key: 'x', alt: true })).toBe(3);
        expect(modifierParam({ key: 'x', shift: true, alt: true })).toBe(4);
        expect(modifierParam({ key: 'x', ctrl: true })).toBe(5);
        expect(modifierParam({ key: 'x', ctrl: true, shift: true })).toBe(6);
        expect(modifierParam({ key: 'x', ctrl: true, alt: true })).toBe(7);
        expect(modifierParam({ key: 'x', ctrl: true, alt: true, shift: true })).toBe(8);
        expect(modifierParam({ key: 'x', meta: true })).toBe(9);
    });
});

describe('encodeKey — printable chars', () => {
    it('encodes plain letters', () => {
        expect(enc('a')).toBe('a');
        expect(enc('z')).toBe('z');
    });

    it('encodes uppercase letters as shift+letter', () => {
        expect(enc('A')).toBe('A');
        expect(visible(enc('shift+a'))).toBe('A');
    });

    it('encodes Ctrl+letter to 0x01..0x1a', () => {
        expect(enc('ctrl+a')).toBe('\x01');
        expect(enc('ctrl+c')).toBe('\x03');
        expect(enc('ctrl+d')).toBe('\x04');
        expect(enc('ctrl+z')).toBe('\x1a');
    });

    it('collapses Ctrl+Shift+letter to the same byte as Ctrl+letter', () => {
        // Terminals can't distinguish these; we preserve that behaviour.
        expect(enc('ctrl+shift+c')).toBe('\x03');
        expect(enc('Ctrl+Shift+Z')).toBe('\x1a');
    });

    it('encodes well-known Ctrl-control aliases', () => {
        expect(enc('ctrl+[')).toBe('\x1b');
        expect(enc('ctrl+\\')).toBe('\x1c');
        expect(enc('ctrl+]')).toBe('\x1d');
        expect(enc('ctrl+space')).toBe('\x00');
        expect(enc('ctrl+@')).toBe('\x00');
        expect(enc('ctrl+?')).toBe('\x7f');
    });

    it('encodes Alt+letter as ESC + letter', () => {
        expect(enc('alt+a')).toBe('\x1ba');
        expect(enc('alt+shift+a')).toBe('\x1bA');
    });

    it('encodes Alt+Ctrl+letter as ESC + ctrl-byte', () => {
        expect(enc('alt+ctrl+a')).toBe('\x1b\x01');
    });

    it('encodes shifted digits on a US layout', () => {
        expect(enc('shift+1')).toBe('!');
        expect(enc('shift+2')).toBe('@');
        expect(enc('shift+8')).toBe('*');
        expect(enc('shift+9')).toBe('(');
        expect(enc('shift+0')).toBe(')');
    });
});

describe('encodeKey — special named keys', () => {
    it('Enter → \\r', () => {
        expect(enc('Enter')).toBe('\r');
        expect(enc('return')).toBe('\r');
    });

    it('Alt+Enter → ESC \\r', () => {
        expect(enc('alt+enter')).toBe('\x1b\r');
    });

    it('Tab → \\t, Shift+Tab → ESC [Z, Alt+Tab → ESC \\t', () => {
        expect(enc('Tab')).toBe('\t');
        expect(enc('shift+tab')).toBe('\x1b[Z');
        expect(enc('alt+tab')).toBe('\x1b\t');
    });

    it('Escape → ESC, Alt+Escape → ESC ESC', () => {
        expect(enc('Escape')).toBe('\x1b');
        expect(enc('esc')).toBe('\x1b');
        expect(enc('alt+escape')).toBe('\x1b\x1b');
    });

    it('Backspace → DEL (0x7f) by default, Ctrl+Backspace → BS (0x08)', () => {
        expect(enc('Backspace')).toBe('\x7f');
        expect(enc('ctrl+backspace')).toBe('\x08');
        expect(enc('alt+backspace')).toBe('\x1b\x7f');
    });

    it('Space → " ", Ctrl+Space → NUL', () => {
        expect(enc('Space')).toBe(' ');
        expect(enc('ctrl+space')).toBe('\x00');
    });
});

describe('encodeKey — arrows / Home / End (CSI letter-form)', () => {
    it('plain arrows', () => {
        expect(enc('Up')).toBe('\x1b[A');
        expect(enc('Down')).toBe('\x1b[B');
        expect(enc('Right')).toBe('\x1b[C');
        expect(enc('Left')).toBe('\x1b[D');
        expect(enc('ArrowUp')).toBe('\x1b[A');
    });

    it('Home / End plain', () => {
        expect(enc('Home')).toBe('\x1b[H');
        expect(enc('End')).toBe('\x1b[F');
    });

    it('Shift+Up → ESC [1;2A', () => {
        expect(enc('shift+up')).toBe('\x1b[1;2A');
    });

    it('Ctrl+Up → ESC [1;5A', () => {
        expect(enc('ctrl+up')).toBe('\x1b[1;5A');
    });

    it('Ctrl+Shift+Up → ESC [1;6A  (common jump-to-top binding)', () => {
        expect(enc('ctrl+shift+up')).toBe('\x1b[1;6A');
    });

    it('Alt+Right → ESC [1;3C', () => {
        expect(enc('alt+right')).toBe('\x1b[1;3C');
    });

    it('Ctrl+Alt+Shift+Down → ESC [1;8B', () => {
        expect(enc('ctrl+alt+shift+down')).toBe('\x1b[1;8B');
    });

    it('Meta+Up → ESC [1;9A', () => {
        expect(enc('meta+up')).toBe('\x1b[1;9A');
    });
});

describe('encodeKey — editing keys (CSI ~-form)', () => {
    it('Ins/Del/PgUp/PgDn plain', () => {
        expect(enc('Insert')).toBe('\x1b[2~');
        expect(enc('Delete')).toBe('\x1b[3~');
        expect(enc('PageUp')).toBe('\x1b[5~');
        expect(enc('PageDown')).toBe('\x1b[6~');
    });

    it('Ctrl+PageUp → ESC [5;5~', () => {
        expect(enc('ctrl+pageup')).toBe('\x1b[5;5~');
    });

    it('Shift+Delete → ESC [3;2~', () => {
        expect(enc('shift+delete')).toBe('\x1b[3;2~');
    });
});

describe('encodeKey — function keys', () => {
    it('F1..F4 use SS3 encoding with no modifiers', () => {
        expect(enc('F1')).toBe('\x1bOP');
        expect(enc('F2')).toBe('\x1bOQ');
        expect(enc('F3')).toBe('\x1bOR');
        expect(enc('F4')).toBe('\x1bOS');
    });

    it('F1..F4 with modifiers upgrade to CSI 1;<mod><letter>', () => {
        expect(enc('shift+F1')).toBe('\x1b[1;2P');
        expect(enc('ctrl+F4')).toBe('\x1b[1;5S');
    });

    it('F5..F12 use CSI ~-form with the right numeric parameters', () => {
        expect(enc('F5')).toBe('\x1b[15~');
        expect(enc('F6')).toBe('\x1b[17~');
        expect(enc('F7')).toBe('\x1b[18~');
        expect(enc('F8')).toBe('\x1b[19~');
        expect(enc('F9')).toBe('\x1b[20~');
        expect(enc('F10')).toBe('\x1b[21~');
        expect(enc('F11')).toBe('\x1b[23~');
        expect(enc('F12')).toBe('\x1b[24~');
    });

    it('F13..F24 parameters', () => {
        expect(enc('F13')).toBe('\x1b[25~');
        expect(enc('F15')).toBe('\x1b[28~');
        expect(enc('F20')).toBe('\x1b[34~');
        expect(enc('F24')).toBe('\x1b[39~');
    });

    it('F-keys with modifiers use the CSI n;<mod>~ form', () => {
        expect(enc('ctrl+F5')).toBe('\x1b[15;5~');
        expect(enc('shift+F12')).toBe('\x1b[24;2~');
    });
});

describe('encodeKeys / encodeText', () => {
    it('encodes a sequence by concatenation', () => {
        const out = encodeKeys([parseKey('h'), parseKey('i')]);
        expect(out).toBe('hi');
    });

    it('encodeText passes through as-is', () => {
        expect(encodeText('hello world')).toBe('hello world');
    });
});

describe('encodeKey — error handling', () => {
    it('throws on invalid printable chars via a hand-crafted spec', () => {
        // Our parser would reject this, but encodeKey shouldn't crash.
        // A multi-char key that isn't named is an error.
        expect(() => encodeKey({ key: 'blah' })).toThrow(KeyEncodeError);
    });
});
