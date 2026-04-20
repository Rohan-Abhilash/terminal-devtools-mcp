/**
 * Keyboard types shared across parser, encoder, and MCP schemas.
 *
 * A `KeySpec` is the canonical, normalised representation of "the user
 * pressed this key with these modifiers".  The parser turns strings like
 * "ctrl+shift+up" into this shape; the encoder turns it into the exact
 * bytes a real xterm-compatible terminal would send.
 */

/** Named (non-printable) keys the encoder knows how to emit. */
export type NamedKey =
    | 'Enter'
    | 'Return'         // alias for Enter in spec, encoded same way
    | 'Tab'
    | 'Escape'
    | 'Esc'            // alias
    | 'Backspace'
    | 'Delete'
    | 'Insert'
    | 'Home'
    | 'End'
    | 'PageUp'
    | 'PageDown'
    | 'ArrowUp'
    | 'ArrowDown'
    | 'ArrowLeft'
    | 'ArrowRight'
    | 'Up'             // alias for ArrowUp
    | 'Down'           // alias for ArrowDown
    | 'Left'           // alias for ArrowLeft
    | 'Right'          // alias for ArrowRight
    | 'Space'
    | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8'
    | 'F9' | 'F10' | 'F11' | 'F12'
    | 'F13' | 'F14' | 'F15' | 'F16' | 'F17' | 'F18' | 'F19' | 'F20'
    | 'F21' | 'F22' | 'F23' | 'F24';

/**
 * A canonical key description.  `key` is either a single printable
 * character (letter, digit, punctuation) or a NamedKey.  Modifier flags
 * that are unset default to false.
 */
export interface KeySpec {
    /** Printable char ("a", "1", "?", " ") OR a NamedKey ("Enter", "F5"). */
    key: string;
    ctrl?: boolean;
    shift?: boolean;
    /** Alt (aka Option on macOS). */
    alt?: boolean;
    /** Meta (aka Cmd on macOS / Super/Windows key elsewhere). */
    meta?: boolean;
}

/**
 * A looser input shape accepted by the public API: either a `KeySpec`
 * object or a string like "a", "ctrl+c", "ctrl+shift+up", "F5".
 */
export type KeyInput = KeySpec | string;
