/**
 * Key parser — turns user-friendly key strings into canonical `KeySpec`s.
 *
 * Accepted syntax (case-insensitive, separators are "+" or "-"):
 *
 *   "a"                 → { key: "a" }
 *   "A"                 → { key: "A" }             (literal capital)
 *   "ctrl+c"            → { key: "c", ctrl: true }
 *   "Ctrl+Shift+Up"     → { key: "ArrowUp", ctrl: true, shift: true }
 *   "alt+enter"         → { key: "Enter", alt: true }
 *   "F5"                → { key: "F5" }
 *   "space"             → { key: "Space" }
 *   "cmd+k"             → { key: "k", meta: true }
 *
 * Synonyms:
 *   control/ctrl/ctl → ctrl
 *   option/opt/alt   → alt
 *   meta/cmd/super/win → meta
 *   up/down/left/right → ArrowUp/ArrowDown/ArrowLeft/ArrowRight
 *   return → Enter, esc → Escape, bs → Backspace, del → Delete
 *   pgup/pgdn → PageUp/PageDown
 */

import { KeyInput, KeySpec, NamedKey } from './types.js';

const MODIFIER_ALIASES: Record<string, keyof Omit<KeySpec, 'key'>> = {
    ctrl: 'ctrl',
    control: 'ctrl',
    ctl: 'ctrl',
    shift: 'shift',
    alt: 'alt',
    option: 'alt',
    opt: 'alt',
    meta: 'meta',
    cmd: 'meta',
    command: 'meta',
    super: 'meta',
    win: 'meta',
    windows: 'meta',
};

/** Case-insensitive lookup of canonical NamedKey form. */
const NAMED_KEY_ALIASES: Record<string, NamedKey> = {
    enter: 'Enter',
    return: 'Enter',      // canonical form is 'Enter'
    tab: 'Tab',
    escape: 'Escape',
    esc: 'Escape',        // canonical form is 'Escape'
    backspace: 'Backspace',
    bs: 'Backspace',
    delete: 'Delete',
    del: 'Delete',
    insert: 'Insert',
    ins: 'Insert',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pgup: 'PageUp',
    pagedown: 'PageDown',
    pgdn: 'PageDown',
    pgdown: 'PageDown',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    space: 'Space',
    spacebar: 'Space',
    f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
    f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
    f13: 'F13', f14: 'F14', f15: 'F15', f16: 'F16', f17: 'F17', f18: 'F18',
    f19: 'F19', f20: 'F20', f21: 'F21', f22: 'F22', f23: 'F23', f24: 'F24',
};

/** True iff `s` is a single printable character we can encode directly. */
function isPrintableSingleChar(s: string): boolean {
    if (s.length !== 1) return false;
    const code = s.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e;
}

/**
 * Normalise a raw token to a canonical key name, or null if it doesn't
 * match any known named key and is not a single printable char.
 */
function normaliseKeyToken(token: string): string | null {
    if (token.length === 0) return null;
    // Single printable char — return as-is (preserve case).
    if (isPrintableSingleChar(token)) return token;
    // Named key / alias lookup is case-insensitive.
    const lc = token.toLowerCase();
    const named = NAMED_KEY_ALIASES[lc];
    if (named) return named;
    return null;
}

export class KeyParseError extends Error {
    constructor(input: string, detail: string) {
        super(`Cannot parse key "${input}": ${detail}`);
        this.name = 'KeyParseError';
    }
}

/**
 * Parse a single key string or `KeySpec` into a canonical `KeySpec`.
 * Throws `KeyParseError` on malformed input.
 */
export function parseKey(input: KeyInput): KeySpec {
    // Already a KeySpec object — validate + normalise.
    if (typeof input === 'object' && input !== null) {
        if (typeof input.key !== 'string' || input.key.length === 0) {
            throw new KeyParseError(JSON.stringify(input), 'empty key field');
        }
        const normalisedKey = normaliseKeyToken(input.key);
        if (normalisedKey === null) {
            throw new KeyParseError(
                JSON.stringify(input),
                `unknown key "${input.key}"`,
            );
        }
        return {
            key: normalisedKey,
            ctrl: !!input.ctrl,
            shift: !!input.shift,
            alt: !!input.alt,
            meta: !!input.meta,
        };
    }

    if (typeof input !== 'string') {
        throw new KeyParseError(String(input), 'expected string or KeySpec');
    }
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        throw new KeyParseError(input, 'empty string');
    }

    const tokens: string[] = splitKeyString(trimmed);
    if (tokens.length === 0) {
        throw new KeyParseError(input, 'empty after splitting');
    }

    // Last token is the key; everything before is modifiers.
    const keyToken = tokens[tokens.length - 1]!;
    const modifierTokens = tokens.slice(0, -1);

    const ctrl = false, shift = false, alt = false, meta = false;
    const spec: KeySpec = { key: '', ctrl, shift, alt, meta };

    for (const modToken of modifierTokens) {
        const mod = MODIFIER_ALIASES[modToken.toLowerCase()];
        if (!mod) {
            throw new KeyParseError(input, `unknown modifier "${modToken}"`);
        }
        spec[mod] = true;
    }

    const key = normaliseKeyToken(keyToken);
    if (key === null) {
        throw new KeyParseError(input, `unknown key "${keyToken}"`);
    }
    spec.key = key;

    // A literal uppercase letter implies Shift.  Don't overwrite an
    // explicit shift flag though: "shift+a" and "A" both mean the same
    // thing logically.  If the user typed a literal capital letter, also
    // mark shift.
    if (
        spec.key.length === 1 &&
        spec.key >= 'A' &&
        spec.key <= 'Z' &&
        !spec.ctrl &&
        !spec.alt &&
        !spec.meta
    ) {
        spec.shift = true;
    }

    return spec;
}

/**
 * Split a key string on "+" or "-".  The tricky case is when the KEY
 * itself is "+" or "-": that happens when those characters appear at the
 * very end of the input preceded by a separator ("ctrl++", "ctrl+-").
 * We detect that case first and peel off the trailing literal; in every
 * other case a plain split on /[+-]/ is correct.
 *
 *  "a"         → ["a"]
 *  "+"         → ["+"]
 *  "ctrl+c"    → ["ctrl", "c"]
 *  "ctrl-c"    → ["ctrl", "c"]
 *  "ctrl++"    → ["ctrl", "+"]
 *  "ctrl+-"    → ["ctrl", "-"]
 *  "shift+="   → ["shift", "="]
 */
function splitKeyString(s: string): string[] {
    // Single-character input — including a bare "+" or "-" — is always
    // a standalone token.
    if (s.length === 1) return [s];

    const last = s[s.length - 1]!;
    const secondLast = s[s.length - 2]!;
    const bothSepAtEnd =
        (last === '+' || last === '-') &&
        (secondLast === '+' || secondLast === '-');

    if (bothSepAtEnd) {
        // "…X++" or "…X+-" or "…X-+" or "…X--" — the very last char is
        // the literal key, and the char before it is the separator
        // between modifiers and key.  Split the modifier head normally.
        const head = s.slice(0, s.length - 2);
        const headTokens = head.split(/[+-]/).filter((t) => t.length > 0);
        return [...headTokens, last];
    }

    return s.split(/[+-]/).filter((t) => t.length > 0);
}

/**
 * Parse an array of key inputs.  Convenience wrapper.
 */
export function parseKeys(inputs: KeyInput[]): KeySpec[] {
    return inputs.map(parseKey);
}
