import { describe, expect, it } from '@jest/globals';
import { KeyParseError, parseKey, parseKeys } from '../../src/keys/parser.js';

describe('parseKey — plain chars and named keys', () => {
    it('parses a single lowercase letter', () => {
        expect(parseKey('a')).toEqual({
            key: 'a', ctrl: false, shift: false, alt: false, meta: false,
        });
    });

    it('parses a single uppercase letter and marks shift=true', () => {
        expect(parseKey('A')).toEqual({
            key: 'A', ctrl: false, shift: true, alt: false, meta: false,
        });
    });

    it('parses digits as-is', () => {
        expect(parseKey('5')).toMatchObject({ key: '5', shift: false });
    });

    it('parses common punctuation as literal key', () => {
        expect(parseKey('?')).toMatchObject({ key: '?' });
        expect(parseKey('.')).toMatchObject({ key: '.' });
        expect(parseKey('/')).toMatchObject({ key: '/' });
    });

    it('parses named keys case-insensitively and normalises to canonical form', () => {
        expect(parseKey('Enter').key).toBe('Enter');
        expect(parseKey('enter').key).toBe('Enter');
        expect(parseKey('ENTER').key).toBe('Enter');
        expect(parseKey('up').key).toBe('ArrowUp');
        expect(parseKey('Up').key).toBe('ArrowUp');
        expect(parseKey('ARROWUP').key).toBe('ArrowUp');
        expect(parseKey('pgdn').key).toBe('PageDown');
        expect(parseKey('PageDown').key).toBe('PageDown');
        expect(parseKey('F5').key).toBe('F5');
        expect(parseKey('f12').key).toBe('F12');
    });

    it('treats return/esc/bs/del/ins as aliases — normalised to canonical', () => {
        expect(parseKey('return').key).toBe('Enter');
        expect(parseKey('esc').key).toBe('Escape');
        expect(parseKey('Esc').key).toBe('Escape');
        expect(parseKey('bs').key).toBe('Backspace');
        expect(parseKey('del').key).toBe('Delete');
        expect(parseKey('ins').key).toBe('Insert');
    });
});

describe('parseKey — modifiers', () => {
    it('parses ctrl+letter', () => {
        expect(parseKey('ctrl+c')).toMatchObject({ key: 'c', ctrl: true });
    });

    it('accepts Ctrl and CTRL and ctl as synonyms', () => {
        expect(parseKey('Ctrl+x').ctrl).toBe(true);
        expect(parseKey('CTRL+x').ctrl).toBe(true);
        expect(parseKey('ctl+x').ctrl).toBe(true);
        expect(parseKey('control+x').ctrl).toBe(true);
    });

    it('accepts shift / alt / meta synonyms', () => {
        expect(parseKey('shift+a').shift).toBe(true);
        expect(parseKey('alt+a').alt).toBe(true);
        expect(parseKey('option+a').alt).toBe(true);
        expect(parseKey('opt+a').alt).toBe(true);
        expect(parseKey('meta+a').meta).toBe(true);
        expect(parseKey('cmd+a').meta).toBe(true);
        expect(parseKey('command+a').meta).toBe(true);
        expect(parseKey('super+a').meta).toBe(true);
        expect(parseKey('win+a').meta).toBe(true);
    });

    it('parses combined modifiers in any order', () => {
        expect(parseKey('ctrl+shift+up')).toMatchObject({
            key: 'ArrowUp', ctrl: true, shift: true,
        });
        expect(parseKey('shift+ctrl+up')).toMatchObject({
            key: 'ArrowUp', ctrl: true, shift: true,
        });
        expect(parseKey('alt+ctrl+shift+f5')).toMatchObject({
            key: 'F5', ctrl: true, shift: true, alt: true,
        });
    });

    it('accepts dashes as separators too', () => {
        expect(parseKey('ctrl-a')).toMatchObject({ key: 'a', ctrl: true });
        expect(parseKey('ctrl-shift-up')).toMatchObject({
            key: 'ArrowUp', ctrl: true, shift: true,
        });
    });

    it('keeps literal "+" and "-" at the end as the key', () => {
        expect(parseKey('ctrl++')).toMatchObject({ key: '+', ctrl: true });
        expect(parseKey('ctrl+-')).toMatchObject({ key: '-', ctrl: true });
        expect(parseKey('shift+=')).toMatchObject({ key: '=', shift: true });
    });
});

describe('parseKey — error handling', () => {
    it('throws on empty string', () => {
        expect(() => parseKey('')).toThrow(KeyParseError);
        expect(() => parseKey('   ')).toThrow(KeyParseError);
    });

    it('throws on unknown modifier', () => {
        expect(() => parseKey('doom+a')).toThrow(/unknown modifier "doom"/);
    });

    it('throws on unknown named key', () => {
        expect(() => parseKey('ctrl+blorf')).toThrow(/unknown key "blorf"/);
    });

    it('throws on non-string non-object inputs', () => {
        // @ts-expect-error deliberate
        expect(() => parseKey(42)).toThrow(KeyParseError);
        // @ts-expect-error deliberate
        expect(() => parseKey(null)).toThrow(KeyParseError);
    });
});

describe('parseKey — accepts KeySpec objects directly', () => {
    it('normalises key aliases and fills defaults', () => {
        expect(parseKey({ key: 'up', ctrl: true })).toEqual({
            key: 'ArrowUp', ctrl: true, shift: false, alt: false, meta: false,
        });
    });

    it('throws on empty key field', () => {
        expect(() => parseKey({ key: '' })).toThrow(KeyParseError);
    });

    it('throws on unknown key field', () => {
        expect(() => parseKey({ key: 'supercali' })).toThrow(KeyParseError);
    });
});

describe('parseKeys — array form', () => {
    it('parses a list of key strings', () => {
        const out = parseKeys(['a', 'ctrl+b', 'Enter']);
        expect(out).toHaveLength(3);
        expect(out[0]!.key).toBe('a');
        expect(out[1]!.ctrl).toBe(true);
        expect(out[2]!.key).toBe('Enter');
    });
});
