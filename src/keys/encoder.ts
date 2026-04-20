/**
 * Key encoder — turns a canonical `KeySpec` into the exact byte sequence
 * a modern xterm-compatible terminal would send when the user pressed
 * that key combination.
 *
 * The implementation follows the well-established xterm(1) conventions
 * (DEC VT220 / SS3 / CSI) that every mainstream terminal emulator and
 * Windows ConPTY understands:
 *
 *   Letters a-z          → literal char
 *   Shift + letter       → uppercase char
 *   Ctrl  + letter       → 0x01..0x1A (letter & 0x1F)
 *   Ctrl+Shift+letter    → same as Ctrl+letter (terminals can't tell apart)
 *   Alt   + X            → ESC + <X's bytes>
 *   Digits 0-9           → literal char; Shift+digit → shifted US symbol
 *   Named keys           → CSI / SS3 sequences from the table below
 *   Named keys + mods    → CSI form with modifier bitfield
 *
 *   modifier code = 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0) + (meta?8:0)
 *   "1;<mod><final>" is appended for arrows, Home, End;
 *   "<n>;<mod>~" for Insert/Delete/PgUp/PgDn/F-keys (CSI ~-form);
 *
 * All sequences are returned as strings (UTF-8 safe — terminals expect
 * the raw bytes, and JavaScript strings map 1:1 to UTF-8 for the ASCII /
 * control-char ranges used here).  Binary bytes never exceed 0x7f from
 * this encoder.
 */

import { KeySpec, NamedKey } from './types.js';

const ESC = '\x1b';

/** Lookup for named keys — primary encoding with no modifiers. */
interface NamedKeyEncoding {
    /**
     * For arrows / Home / End: final char of the CSI form (A/B/C/D/H/F).
     * For F1–F4:               final char of the SS3 form (P/Q/R/S).
     * For Ins/Del/PgUp/PgDn/F5+: numeric parameter of the CSI ~-form.
     */
    kind: 'csi-letter' | 'ss3' | 'csi-tilde';
    /** For csi-letter / ss3 — the terminator (last char of the sequence). */
    letter?: string;
    /** For csi-tilde — the numeric parameter before "~". */
    num?: number;
}

const NAMED_KEY_TABLE: Record<NamedKey, NamedKeyEncoding | 'special'> = {
    // Arrows use CSI letter-form: ESC [ A..D
    ArrowUp:    { kind: 'csi-letter', letter: 'A' },
    ArrowDown:  { kind: 'csi-letter', letter: 'B' },
    ArrowRight: { kind: 'csi-letter', letter: 'C' },
    ArrowLeft:  { kind: 'csi-letter', letter: 'D' },
    // Aliases — alias expansion is the parser's job, but if we get here
    // directly we still encode correctly.
    Up:    { kind: 'csi-letter', letter: 'A' },
    Down:  { kind: 'csi-letter', letter: 'B' },
    Right: { kind: 'csi-letter', letter: 'C' },
    Left:  { kind: 'csi-letter', letter: 'D' },

    // Home / End — there are two common forms.  We use CSI H / F which
    // is what xterm uses by default ("application cursor keys" mode
    // would use ESC O H / ESC O F, but most TUIs still accept both and
    // readline / Ink decode both).
    Home: { kind: 'csi-letter', letter: 'H' },
    End:  { kind: 'csi-letter', letter: 'F' },

    // CSI ~-form editing keys.
    Insert:   { kind: 'csi-tilde', num: 2 },
    Delete:   { kind: 'csi-tilde', num: 3 },
    PageUp:   { kind: 'csi-tilde', num: 5 },
    PageDown: { kind: 'csi-tilde', num: 6 },

    // F1–F4 use SS3 (ESC O P..S)
    F1: { kind: 'ss3', letter: 'P' },
    F2: { kind: 'ss3', letter: 'Q' },
    F3: { kind: 'ss3', letter: 'R' },
    F4: { kind: 'ss3', letter: 'S' },
    // F5–F24 use CSI ~-form.  Numbering jumps at F5/F6/F7 etc. for
    // historical reasons.
    F5:  { kind: 'csi-tilde', num: 15 },
    F6:  { kind: 'csi-tilde', num: 17 },
    F7:  { kind: 'csi-tilde', num: 18 },
    F8:  { kind: 'csi-tilde', num: 19 },
    F9:  { kind: 'csi-tilde', num: 20 },
    F10: { kind: 'csi-tilde', num: 21 },
    F11: { kind: 'csi-tilde', num: 23 },
    F12: { kind: 'csi-tilde', num: 24 },
    F13: { kind: 'csi-tilde', num: 25 },
    F14: { kind: 'csi-tilde', num: 26 },
    F15: { kind: 'csi-tilde', num: 28 },
    F16: { kind: 'csi-tilde', num: 29 },
    F17: { kind: 'csi-tilde', num: 31 },
    F18: { kind: 'csi-tilde', num: 32 },
    F19: { kind: 'csi-tilde', num: 33 },
    F20: { kind: 'csi-tilde', num: 34 },
    F21: { kind: 'csi-tilde', num: 36 },
    F22: { kind: 'csi-tilde', num: 37 },
    F23: { kind: 'csi-tilde', num: 38 },
    F24: { kind: 'csi-tilde', num: 39 },

    // Handled specially — no NamedKeyEncoding entry.
    Enter: 'special',
    Return: 'special',
    Tab: 'special',
    Escape: 'special',
    Esc: 'special',
    Backspace: 'special',
    Space: 'special',
};

/** Shifted-digit characters on a standard US keyboard. */
const SHIFTED_DIGITS: Record<string, string> = {
    '0': ')', '1': '!', '2': '@', '3': '#', '4': '$',
    '5': '%', '6': '^', '7': '&', '8': '*', '9': '(',
};

export class KeyEncodeError extends Error {
    constructor(spec: KeySpec, reason: string) {
        super(`Cannot encode ${JSON.stringify(spec)}: ${reason}`);
        this.name = 'KeyEncodeError';
    }
}

/**
 * Compute the xterm modifier parameter for a `KeySpec`.  Returns a value
 * in the range 1..16, where 1 means "no modifiers".
 */
export function modifierParam(spec: KeySpec): number {
    return (
        1 +
        (spec.shift ? 1 : 0) +
        (spec.alt ? 2 : 0) +
        (spec.ctrl ? 4 : 0) +
        (spec.meta ? 8 : 0)
    );
}

/** Returns true iff the spec has any modifier set. */
function hasAnyModifier(spec: KeySpec): boolean {
    return !!(spec.ctrl || spec.shift || spec.alt || spec.meta);
}

/** Ctrl+letter (and digits/common symbols) encoding. */
function encodeCtrl(ch: string): string | null {
    if (ch.length !== 1) return null;
    const c = ch.toLowerCase();
    // Letters a-z → 0x01 .. 0x1a
    if (c >= 'a' && c <= 'z') {
        return String.fromCharCode(c.charCodeAt(0) - 'a'.charCodeAt(0) + 1);
    }
    // Common control-char aliases terminals respect:
    //   ctrl+@ / ctrl+space → NUL (0x00)
    //   ctrl+[             → ESC (0x1b)
    //   ctrl+\             → FS  (0x1c)
    //   ctrl+]             → GS  (0x1d)
    //   ctrl+^             → RS  (0x1e)
    //   ctrl+_             → US  (0x1f)
    //   ctrl+?             → DEL (0x7f)  (ctrl+8 on some layouts too)
    if (c === '@' || c === ' ') return '\x00';
    if (c === '[') return '\x1b';
    if (c === '\\') return '\x1c';
    if (c === ']') return '\x1d';
    if (c === '^') return '\x1e';
    if (c === '_') return '\x1f';
    if (c === '?') return '\x7f';
    // No conventional ctrl encoding for other chars.
    return null;
}

/**
 * Encode a single `KeySpec` into the raw bytes a terminal would emit.
 * Throws `KeyEncodeError` if the combination is not representable.
 */
export function encodeKey(spec: KeySpec): string {
    const { key } = spec;

    // ── Special named keys ──────────────────────────────────────────
    if (key === 'Enter' || key === 'Return') {
        // Ctrl+Enter, Shift+Enter, etc. are not standard and most
        // terminals just emit \r regardless.
        return spec.alt ? ESC + '\r' : '\r';
    }
    if (key === 'Tab') {
        if (spec.shift && !spec.ctrl && !spec.alt && !spec.meta) {
            // Shift+Tab → ESC [Z (standard backtab)
            return ESC + '[Z';
        }
        return spec.alt ? ESC + '\t' : '\t';
    }
    if (key === 'Escape' || key === 'Esc') {
        return spec.alt ? ESC + ESC : ESC;
    }
    if (key === 'Backspace') {
        // Most terminals send DEL (0x7f); Ctrl+Backspace often sends BS (0x08).
        if (spec.ctrl) return spec.alt ? ESC + '\x08' : '\x08';
        return spec.alt ? ESC + '\x7f' : '\x7f';
    }
    if (key === 'Space') {
        if (spec.ctrl) return spec.alt ? ESC + '\x00' : '\x00';
        return spec.alt ? ESC + ' ' : ' ';
    }

    // ── Named keys with CSI / SS3 encoding ──────────────────────────
    const namedEntry = NAMED_KEY_TABLE[key as NamedKey];
    if (namedEntry && namedEntry !== 'special') {
        return encodeNamedKey(namedEntry, spec);
    }

    // ── Printable single char ───────────────────────────────────────
    if (key.length === 1) {
        return encodePrintableChar(key, spec);
    }

    throw new KeyEncodeError(spec, `unknown key "${key}"`);
}

function encodeNamedKey(enc: NamedKeyEncoding, spec: KeySpec): string {
    const modParam = modifierParam(spec);
    const needsModifier = modParam !== 1;

    if (enc.kind === 'csi-letter') {
        if (!enc.letter) throw new Error('csi-letter encoding missing letter');
        if (!needsModifier) return ESC + '[' + enc.letter;
        return ESC + '[1;' + String(modParam) + enc.letter;
    }
    if (enc.kind === 'ss3') {
        if (!enc.letter) throw new Error('ss3 encoding missing letter');
        // SS3 with modifiers upgrades to the CSI 1;<mod><letter> form —
        // this is how xterm encodes e.g. Shift+F1 (ESC [1;2P).
        if (!needsModifier) return ESC + 'O' + enc.letter;
        return ESC + '[1;' + String(modParam) + enc.letter;
    }
    if (enc.kind === 'csi-tilde') {
        if (enc.num === undefined) throw new Error('csi-tilde encoding missing num');
        if (!needsModifier) return ESC + '[' + String(enc.num) + '~';
        return ESC + '[' + String(enc.num) + ';' + String(modParam) + '~';
    }
    // Exhaustiveness guard.
    throw new Error(`unknown named-key encoding kind: ${(enc as { kind: string }).kind}`);
}

function encodePrintableChar(ch: string, spec: KeySpec): string {
    // Letters: Ctrl takes precedence over Shift (terminals can't
    // distinguish Ctrl+a from Ctrl+Shift+a reliably).
    const isLetter = /^[a-zA-Z]$/.test(ch);
    const isDigit = /^[0-9]$/.test(ch);

    if (spec.ctrl) {
        const ctrled = encodeCtrl(ch);
        if (ctrled !== null) {
            return spec.alt ? ESC + ctrled : ctrled;
        }
        // Falls through: no ctrl encoding for this char, treat as Alt-prefixed
        // literal.  Better than throwing — some keys (e.g. Ctrl+comma) are
        // just not representable in terminals, we emit the literal so the
        // app at least sees the char.
    }

    if (spec.shift && isLetter) {
        // Shift + letter → uppercase
        const shifted = ch.toUpperCase();
        return spec.alt ? ESC + shifted : shifted;
    }
    if (spec.shift && isDigit) {
        const shifted = SHIFTED_DIGITS[ch];
        if (shifted) return spec.alt ? ESC + shifted : shifted;
    }

    // Plain (maybe Alt-prefixed) single char.
    if (spec.meta && !spec.alt) {
        // meta-only modifiers have no universal terminal encoding; we
        // do our best by treating them as Alt (ESC prefix), which matches
        // how iTerm / Alacritty / GNOME-Terminal with "meta as escape"
        // actually behave.
        return ESC + ch;
    }
    return spec.alt ? ESC + ch : ch;
}

/** Convenience: encode several keys in order. */
export function encodeKeys(specs: KeySpec[]): string {
    return specs.map(encodeKey).join('');
}

/**
 * Encode a plain-text string — sends each character literally.  Useful
 * for typing into TUI inputs.  Differs from encodeKeys because it
 * bypasses all modifier parsing.
 */
export function encodeText(text: string): string {
    return text;
}
