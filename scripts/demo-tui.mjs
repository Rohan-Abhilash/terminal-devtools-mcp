#!/usr/bin/env node
/**
 * Minimal self-contained TUI used by `scripts/demo-visible.mjs` and the
 * e2e tests.  Needs nothing but a real TTY on stdin/stdout — no extra
 * dependencies.
 *
 * It's deliberately simple but exercises most of the features any real
 * TUI relies on:
 *   - alternate screen buffer (so the host shell's history is preserved
 *     while the TUI runs);
 *   - hidden cursor;
 *   - absolute-positioned drawing with ANSI CSI;
 *   - raw-mode stdin decoding ctrl+c, arrow keys, q-to-quit.
 *
 * Controls:
 *   ArrowUp    counter += 1
 *   ArrowDown  counter -= 1
 *   ArrowRight counter += 10
 *   ArrowLeft  counter  = 0
 *   r          randomise
 *   q / Ctrl+C quit
 */

const ESC = '\x1b';
const CSI = `${ESC}[`;
const write = (s) => process.stdout.write(s);

const enterAltScreen = () => write(`${CSI}?1049h`);
const leaveAltScreen = () => write(`${CSI}?1049l`);
const hideCursor = () => write(`${CSI}?25l`);
const showCursor = () => write(`${CSI}?25h`);
const clear = () => write(`${CSI}2J${CSI}H`);
const moveTo = (row, col) => write(`${CSI}${row};${col}H`);
const bold = (s) => `${CSI}1m${s}${CSI}22m`;
const dim = (s) => `${CSI}2m${s}${CSI}22m`;

const state = {
    counter: 0,
    lastKey: '<none>',
    frame: 0,
    running: true,
};

function render() {
    clear();
    moveTo(1, 1);
    write(bold('tui-tester demo TUI'));
    moveTo(2, 1);
    write('===================');

    moveTo(4, 1);
    write(`Counter : ${bold(String(state.counter))}`);
    moveTo(5, 1);
    write(`Last key: ${state.lastKey}`);
    moveTo(6, 1);
    write(`Frame   : ${state.frame}`);

    moveTo(8, 1);
    write(dim('ArrowUp/Down:  +1 / -1         ArrowRight/Left: +10 / reset'));
    moveTo(9, 1);
    write(dim('r:             randomise       q or Ctrl+C:     quit'));

    moveTo(11, 1);
    write('READY');

    state.frame += 1;
}

function quit(code = 0) {
    if (!state.running) return;
    state.running = false;
    showCursor();
    leaveAltScreen();
    process.stdout.write(`\nGoodbye! Final counter: ${state.counter}\n`);
    process.exit(code);
}

enterAltScreen();
hideCursor();
render();

if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(true); } catch { /* ignore */ }
}
process.stdin.resume();
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
    const s = chunk.toString();

    if (s === '\x03' || s === 'q') { quit(0); return; }

    if (s === `${CSI}A`) { state.counter += 1; state.lastKey = 'ArrowUp'; }
    else if (s === `${CSI}B`) { state.counter -= 1; state.lastKey = 'ArrowDown'; }
    else if (s === `${CSI}C`) { state.counter += 10; state.lastKey = 'ArrowRight'; }
    else if (s === `${CSI}D`) { state.counter = 0; state.lastKey = 'ArrowLeft'; }
    else if (s === 'r') { state.counter = Math.floor(Math.random() * 100); state.lastKey = 'r'; }
    else {
        // Render a human-readable hint of the escape sequence so the
        // test can verify that unknown input reached the TUI.
        state.lastKey = JSON.stringify(s);
    }

    render();
});

process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));
process.on('SIGHUP', () => quit(0));
