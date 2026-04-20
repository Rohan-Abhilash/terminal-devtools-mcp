# tui-tester

A **Model Context Protocol** server that gives AI agents full, programmatic control of terminal user interfaces — spawn them in a real PTY, send any key combination, read back the rendered screen, and observe animations frame-by-frame.

Think "Chrome DevTools MCP, but for TUIs". If an AI can test a web app by driving Chrome, this lets it test a terminal app the exact same way.

> **Scope.** Anything that draws with a terminal emulator works: curses / ncurses apps, Python `prompt_toolkit`, Go `bubbletea`, Rust `ratatui`, Node `ink` / `blessed`, `vim`, `less`, `htop`, shells, REPLs, and so on. Cross-platform where PTYs exist (macOS, Linux, Windows via ConPTY).

---

## Features at a glance

| | |
|---|---|
| **Real PTYs** | Every session runs inside `node-pty`. The child sees a proper TTY with configurable `TERM`, `COLUMNS`, `ROWS` and `env`. SIGWINCH, bracketed paste, alt-screen — all work. |
| **Every key combination** | "ctrl+c", "ctrl+shift+up", "F5", "alt+enter", "shift+tab", "cmd+k" — parsed into canonical `KeySpec`s and encoded as the exact bytes a real xterm-compatible terminal emits (CSI + SS3 with modifier bitfields). |
| **Before/after on every input** | Every `send_keys` / `send_text` / `send_raw` / `hold_key` / `type_text` call returns a `screen` block with the terminal text *before* the input, *after* it, and a row-level diff of exactly what changed. No separate snapshot round-trip needed. |
| **Inline `waitFor`** | Any input tool can optionally `waitFor` a specific text (or regex) to appear on screen *before the call returns*, and the `after` snapshot is timed to the exact frame it first matched. Agents never miss transient post-input states (resolved spinners, one-shot prompts, streaming output that settles) that would otherwise disappear before a follow-up `wait_for_text` could land. |
| **Rendered-screen snapshots** | Bytes go through `@xterm/headless`, the same terminal emulator VS Code uses. You get the cursor position, text grid, per-cell colours, bold/italic/underline, everything. Pass `includeScrollback: true` on `snapshot` / `get_text` to also retrieve the full output buffer — every line ever rendered, not just what's currently on screen. |
| **Frame-level monitoring** | Record diffs of the screen at a configurable poll rate and inspect animations, spinners, streaming output, or anything that changes over time. |
| **Visible viewer window** | **Recommended default for every interactive session.** `visible: true` opens a real macOS/Linux terminal window that mirrors the PTY byte-for-byte so the human can watch the agent drive the TUI live. Tool descriptions instruct AI agents to opt in by default; only skip it for headless / CI runs. |
| **Smart waiting** | `wait_for_text` (string or regex), `wait_for_idle` — no need for `sleep` in your test scripts. |
| **Isolated & bounded** | Sessions are independent, capped per-process, cleaned up on server exit. No orphan PTYs, ever. |
| **Thoroughly tested** | Key-encoder bit-exact against the xterm spec; live PTY integration tests; end-to-end tests of the tool surface against real shells. |

---

## Install

```bash
git clone https://github.com/Rohan-Abhilash/terminal-devtools-mcp.git
cd terminal-devtools-mcp
npm install
npm run build
```

Node 18 or newer.

---

## Register with your MCP client

Any MCP-capable client (e.g. ones that accept an `mcpServers` block in their settings) can use tui-tester. Add an entry like the one below to your client's MCP settings file:

```json
{
  "mcpServers": {
    "tui-tester": {
      "command": "node",
      "args": ["/absolute/path/to/tui-tester/dist/index.js"]
    }
  }
}
```

After a restart the client should list the tui-tester tools.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TUI_TESTER_MAX_SESSIONS` | `32` | Maximum concurrent sessions per server process. |
| `TUI_TESTER_MAX_MONITORS` | `16` | Maximum concurrent monitors per server process. |

---

## Tool reference

### Session lifecycle

#### `start_session`
Spawn a TUI inside a fresh PTY.

```json
{
  "command": "node",
  "args": ["./my-cli.js", "--flag"],
  "cwd": "/work/repo",
  "env": { "NO_COLOR": "1" },
  "cols": 120,
  "rows": 40,
  "term": "xterm-256color",
  "name": "main",
  "visible": true
}
```
Returns `{ sessionId, info }`. Use the `sessionId` in every other call.

> ### Guidance for AI agents: **always pass `visible: true`**
>
> The tool descriptions shipped with this server mark `visible: true` as the recommended default for every interactive session. When an agent calls `start_session` without `visible: true`, the human who set up the MCP server has no real-time view of what the agent is doing — they only see the JSON the agent sees. With `visible: true`, a real terminal window opens on the user's desktop and mirrors every byte the PTY emits, giving both sides (agent + human) the same observable state, at the same time.
>
> Only omit `visible: true` when the caller has explicitly asked for a headless / silent run (e.g. CI, batch jobs, or servers without a display).

**`visible: true` — watch the agent work live.** Opens a real OS terminal window (Terminal.app on macOS, `x-terminal-emulator` / gnome-terminal / konsole / xterm on Linux) that `cat`s a named pipe carrying every byte the PTY emits. The human watching sees exactly the same TUI state the agent sees, rendered natively by the host terminal — no extra emulator, no buffering, no round-trip latency. The window auto-closes when the session ends. Windows is not currently supported; `visible` is a silent no-op on unsupported platforms.

Advanced users can override the viewer spawn command with `viewerCommand: { command, args }` — `args` may contain `{fifo}` and `{title}` placeholders:
```jsonc
// force a custom Kitty instance at a specific size
{
  "command": "node", "args": ["./my-cli.js"],
  "visible": true,
  "viewerCommand": {
    "command": "kitty",
    "args": ["--title={title}", "-o", "remember_window_size=no",
             "bash", "-c", "cat '{fifo}'"]
  }
}
```

#### `stop_session`
Kill a session. Default `SIGTERM`, escalates to `SIGKILL`.

```json
{ "sessionId": "tui-xxx", "signal": "SIGTERM" }
```

#### `list_sessions`
Every session the server is tracking, with its lifecycle state, pid, exit code, bytes out, etc.

---

### Sending input

All input tools accept either **string** key specs or structured `KeySpec` objects.

#### Every input tool returns before/after

By default, `send_keys`, `send_text`, `send_raw`, `hold_key`, and `type_text` all return a `screen` block with the terminal text before the input, after it, and a row-level diff of exactly what changed. The agent gets closed-loop feedback on every keystroke without a separate `snapshot()` call:

```jsonc
// request
{ "sessionId": "tui-xxx", "keys": "space" }

// response
{
  "sessionId": "tui-xxx",
  "keyCount": 1,
  "bytesSent": 1,
  "specs": [ … ],
  "screen": {
    "before": {
      "text": "…   [x] chrome-devtools …",
      "lines": [ … ],
      "cursor": { "row": 11, "col": 0, "visible": false },
      "cols": 100, "rows": 28
    },
    "after": {
      "text": "…   [ ] chrome-devtools …",
      "lines": [ … ],
      "cursor": { "row": 11, "col": 0, "visible": false },
      "cols": 100, "rows": 28
    },
    "diff": {
      "identical": false,
      "cursorMoved": false,
      "resized": false,
      "changedLines": [
        { "row": 5,
          "before": " |  > [x] chrome-devtools … |",
          "after":  " |  > [ ] chrome-devtools … |" }
      ],
      "addedRows": [], "removedRows": []
    },
    "waitAfterMs": 150,
    "totalMs": 151
  }
}
```

Three optional knobs tune this behaviour, available on every input tool:

| Option | Default | Meaning |
|---|---|---|
| `captureScreen` | `true` | Set `false` to skip the before/after capture and get back just the basic result (useful when the caller only cares about side-effects, or to keep payload sizes small). |
| `waitAfterMs` | `150` | After the action runs and the parser flushes, wait this many ms before taking the "after" snapshot. Gives the TUI time to react on its next render tick. Set `0` for the tightest possible capture; max `5000`. Ignored when `waitFor` is set. |
| `waitFor` | `undefined` | See below — submit the input AND block until a specific text appears, in a single round-trip. |

If nothing visible changed the response still carries `screen`, but with `diff.identical: true` and `changedLines: []`.

#### `waitFor` — land the input and wait for a specific response in one call

`wait_for_text` as a follow-up call is great, but the agent can only issue it once the previous `send_*` response comes back. That round-trip is often enough for a fast-moving TUI to overwrite the transient state the agent was trying to catch — a spinner that resolves, a one-shot flash message, a prompt that scrolls off, streamed output that settles. Passing `waitFor` to the input tool itself lets the server do the polling inline, so the `after` snapshot is timed to the exact frame the pattern first appeared:

```jsonc
// request: submit "build\n", then wait up to 5s for "Compiled successfully"
{ "sessionId": "tui-xxx",
  "text": "build\n",
  "waitFor": {
    "pattern": "Compiled successfully",
    "timeoutMs": 5000
  } }

// response — added on top of the usual `screen` block:
{
  "sessionId": "tui-xxx",
  "bytesSent": 6,
  "screen": { "before": {…}, "after": {…}, "diff": {…},
              "waitAfterMs": 0, "totalMs": 812 },
  "waitFor": {
    "pattern": "Compiled successfully",
    "matched": true,
    "match": "Compiled successfully",
    "elapsedMs": 809,
    "timedOut": false,
    "timeoutMs": 5000,
    "matchedAgainst": "screen"
  }
}
```

Options inside `waitFor`:

| Key | Default | Meaning |
|---|---|---|
| `pattern` | *(required)* | Literal substring by default, or a RegExp source when `regex: true`. |
| `regex` | `false` | Treat `pattern` as a RegExp source. |
| `regexFlags` | `""` | Flags for the RegExp (`"i"`, `"m"`, `"s"`, …). Only when `regex: true`. |
| `timeoutMs` | `5000` | Max time to poll before giving up. Clamped to `[10, 600000]`. |
| `pollIntervalMs` | `50` | Gap between polls. Clamped to `[10, 5000]`. |
| `matchScreen` | `true` | Match against the visible screen. Set `false` to match against the raw PTY buffer — use this when the expected text scrolls past the viewport faster than the poll interval can catch. |
| `errorOnTimeout` | `false` | When `true`, a miss produces an `isError: true` tool result. When `false`, the tool still returns normally with `waitFor.matched: false, waitFor.timedOut: true`, and the `after` snapshot reflects the screen at the timeout instant. |

For a regex, `waitFor.match` is the full match followed by any capture groups as a `string[]` (the result of `Array.from(regExpMatchArray)`). For a string, it's that same string. For a timeout, it's `null`.

**When `waitFor` is set, `waitAfterMs` is ignored** — polling replaces the fixed settle window, so the "after" snapshot fires the moment the pattern appears rather than after an arbitrary wall-clock delay.

This works with every input tool: `send_keys`, `send_text`, `send_raw`, `hold_key`, and `type_text` all accept the same `waitFor` shape.

#### `send_keys` — the main input tool
```json
{ "sessionId": "tui-xxx", "keys": "ctrl+c" }
```
or
```json
{ "sessionId": "tui-xxx",
  "keys": ["ctrl+shift+up", "shift+tab", { "key": "F5" }, "Enter"] }
```

Every modifier combination supported by xterm/ConPTY is handled — Shift, Ctrl, Alt (Option), Meta (Cmd/Win). Modifier strings recognised: `ctrl` / `control` / `ctl`, `shift`, `alt` / `option` / `opt`, `meta` / `cmd` / `super` / `win`. Separators `+` or `-`.

#### `send_text` — plain typed text
```json
{ "sessionId": "tui-xxx", "text": "hello world\n" }
```
No modifier parsing. Use for "typing" into an input box.

#### `send_raw` — arbitrary bytes (escape hatch)
```json
{ "sessionId": "tui-xxx", "hex": "1b5b41" }    // ESC [ A  (cursor up)
{ "sessionId": "tui-xxx", "base64": "Gw==" }
{ "sessionId": "tui-xxx", "utf8": "héllo" }
```

#### `hold_key` — simulate a held key
```json
{ "sessionId": "tui-xxx",
  "key": "shift+up",
  "durationMs": 800,
  "intervalMs": 30,
  "waitAfterMs": 300 }
```
Perfect for testing key-repeat features (auto-scroll acceleration, fast-forward, etc.). The `screen` block here shows the state before the hold began vs. after it ended.

#### `type_text` — realistic per-character typing
```json
{ "sessionId": "tui-xxx", "text": "hello world", "cps": 80 }
```
For TUIs that handle paste vs typed input differently (bracketed-paste, autocompletion triggered per keystroke). The `screen` block spans the whole typing interval — `before` is the state when typing began, `after` is the state after the last character settled.

---

### Reading the screen

#### `snapshot`
Full rendered screen.
```json
{ "sessionId": "tui-xxx", "format": "text" }   // default
// format: "text" | "ansi" | "cells" | "all"
```
Returns:
```jsonc
{
  "cols": 120, "rows": 40,
  "cursor": { "row": 5, "col": 12, "visible": true },
  "text":  "line 0\nline 1\n…",
  "ansi":  "\u001b[1;32mline 0\u001b[0m\n…",   // if format includes ansi
  "cells": [[ {char,width,fg,bg,bold,…}, … ], …] // if format includes cells
}
```

##### `includeScrollback: true` — full terminal output buffer

Long-running commands routinely produce more output than fits on screen. By default `snapshot` only returns the visible viewport; pass `includeScrollback: true` to additionally receive every line the terminal has rendered since the session started — scrollback *and* the visible rows.

```jsonc
{ "sessionId": "tui-xxx",
  "format": "text",
  "includeScrollback": true,
  "maxScrollbackLines": 10000 }     // optional safety cap, default 10 000

// response adds:
{
  // … existing viewport fields (text, lines, cursor, cols, rows) …
  "scrollback": {
    "totalLines": 1842,             // lines in the active buffer
    "viewportStartLine": 1802,      // first visible line index
    "viewportEndLine":   1841,      // last visible line index (inclusive)
    "lines": [ /* every line from 0..totalLines-1 */ ],
    "text":  "all lines joined with \\n",
    "isAltScreen": false,           // true for full-screen TUIs
    "normalBuffer": { /* only when isAltScreen==true — the pre-TUI shell
                         history from the hidden normal buffer */ },
    "truncated": false,             // true when totalLines > maxScrollbackLines
                                    //   (tail is kept when this happens)
    "maxLines":  10000
  }
}
```

When the session is on the alt-screen (e.g. `vim`, `htop`, Ink apps that clear the terminal), `scrollback.isAltScreen` is `true` and `scrollback.lines` comes from the alt buffer; the `scrollback.normalBuffer` field then carries the shell history that the TUI pushed aside — handy for post-mortem inspection once the TUI exits.

#### `get_text` — just the visible text (smaller payload)
Same `includeScrollback` / `maxScrollbackLines` options as `snapshot`.

#### `get_cursor` — just `{ row, col, visible }`

#### `wait_for_text` — block until something appears
```jsonc
{ "sessionId": "tui-xxx",
  "pattern": "Press Ctrl+C to quit",
  "timeoutMs": 5000 }

// or regex
{ "sessionId": "tui-xxx",
  "pattern": "version=([\\d.]+)",
  "regex": true, "regexFlags": "i",
  "timeoutMs": 5000 }
```

#### `wait_for_idle` — block until output stops
```json
{ "sessionId": "tui-xxx", "idleMs": 500, "timeoutMs": 5000 }
```
Perfect between "send keys" and "snapshot".

#### `get_raw_output` / `get_exit_info`
Raw bytes emitted by the PTY since start (for when the live-screen snapshot is too small to hold the whole history) and the exit status + tail.

---

### Observing change

#### `start_monitor` + `stop_monitor`
Record per-row diffs over time.
```jsonc
// begin recording
{ "sessionId": "tui-xxx", "intervalMs": 100,
  "keepIdenticalFrames": false, "maxFrames": 5000 }
// → { monitorId: "mon-..." }

// some time later …
{ "monitorId": "mon-..." }
// → { frameCount, changedFrameCount, durationMs,
//     frames: [ { takenAt, offsetMs, changed, text,
//                 cursor, diff: { changedLines, addedRows, ... } },
//               … ] }
```

#### `diff_snapshots` — stateless helper
Compare any two snapshots (as JSON) and return per-row changes. Useful for A/B testing or custom flows.

---

### Control

#### `resize`
```json
{ "sessionId": "tui-xxx", "cols": 100, "rows": 30 }
```
Delivers SIGWINCH to the child so TUIs can re-layout. Both the PTY and the internal xterm emulator update in lock-step.

---

## Example agent workflow

Pseudo-transcript of an AI agent verifying a TUI's "Ctrl+Shift+Up jumps to top" feature. Notice every input call comes back with its own `screen.before` / `screen.after` / `screen.diff`, and a couple of them also carry an inline `waitFor` result — the agent almost never needs a separate `snapshot()` or `wait_for_text` call:

```jsonc
→ start_session { command: "node", args: ["./my-cli.js"], visible: true }
← { sessionId: "tui-abc", … }

// First input also acts as a wait_for_text: submit and block until READY.
→ send_keys { sessionId: "tui-abc", keys: "Enter",
              waitFor: { pattern: "READY", timeoutMs: 5000 } }
← { bytesSent: 1,
    screen: { before: {…}, after: {…}, diff: {…} },
    waitFor: { matched: true, match: "READY", elapsedMs: 234, timedOut: false } }

// Give it a long log to scroll through, wait for the tail to finish
// streaming — catches the final line even if it scrolls fast.
→ send_text { sessionId: "tui-abc",
              text: "tail -n 1000 /var/log/system.log\n",
              waitFor: { pattern: "--- end of log ---", timeoutMs: 10000 } }
← { bytesSent: 36,
    screen: { before: {…}, after: {…},
              diff: { changedLines: [ /* lots of new log lines */ ] } },
    waitFor: { matched: true, match: "--- end of log ---", elapsedMs: 812 } }

// Start recording, scroll up the long way, then jump.
→ start_monitor { sessionId: "tui-abc", intervalMs: 50 }
← { monitorId: "mon-1" }

→ hold_key  { sessionId: "tui-abc", key: "shift+up", durationMs: 300 }
← { events: 11,
    screen: { /* before=bottom of log, after=several pages up */ } }

// Pass `waitFor` so we also confirm the exact "top-of-log" marker
// landed — snapshot is taken the instant it appears.
→ send_keys { sessionId: "tui-abc", keys: "ctrl+shift+up",
              waitFor: { pattern: "=== top of log ===", timeoutMs: 2000 } }
← { bytesSent: 10,
    screen: { before: {…}, after: {…},
              diff: { changedLines: [ { row: 0,
                                        after: "=== top of log ===" }, … ] } },
    waitFor: { matched: true, match: "=== top of log ===", elapsedMs: 42 } }

→ stop_monitor { monitorId: "mon-1" }
← { frames: [ … 20+ frames … ] }

→ stop_session { sessionId: "tui-abc" }
```

The agent now has full proof that the boot landed (`waitFor` on "READY"), the tail streamed to completion (`waitFor` on "--- end of log ---"), holding Shift+↑ scrolled, and Ctrl+Shift+↑ jumped to the very top — all without a single extra `snapshot()` or `wait_for_text` call.

---

## Key encoding reference

Everything below is tested bit-for-bit against the xterm spec.

### Printable characters

| Combination | Bytes |
|---|---|
| `a` | `0x61` (literal) |
| `A`, `shift+a` | `0x41` (shifted) |
| `ctrl+a` … `ctrl+z` | `0x01` … `0x1a` |
| `ctrl+shift+a` | `0x01` (same as ctrl+a — terminals can't distinguish) |
| `alt+a` | `ESC 0x61` |
| `alt+shift+a` | `ESC 0x41` |
| `alt+ctrl+a` | `ESC 0x01` |
| `shift+1` | `!` (US-layout shifted digit) |
| `ctrl+space`, `ctrl+@` | `0x00` (NUL) |
| `ctrl+[` | `0x1b` (ESC) |

### Named keys (no modifiers)

| Key | Bytes |
|---|---|
| `Enter` | `\r` |
| `Tab` | `\t` |
| `Shift+Tab` | `ESC [Z` |
| `Escape` | `ESC` |
| `Backspace` | `\x7f` |
| `Space` | `' '` |
| `ArrowUp` | `ESC [A` |
| `ArrowDown` | `ESC [B` |
| `ArrowRight` | `ESC [C` |
| `ArrowLeft` | `ESC [D` |
| `Home` | `ESC [H` |
| `End` | `ESC [F` |
| `Insert` | `ESC [2~` |
| `Delete` | `ESC [3~` |
| `PageUp` | `ESC [5~` |
| `PageDown` | `ESC [6~` |

### With modifiers

For arrows, Home, End:
```
ESC [ 1 ; M <letter>
```
For Insert, Delete, PageUp/Down, and F5–F24:
```
ESC [ <n> ; M ~
```
Where **M** is the xterm modifier bitfield:

```
M = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0) + (meta ? 8 : 0)
```

So `ctrl+shift+up` → `ESC [1;6A`, `alt+PageUp` → `ESC [5;3~`, and so on.

### Function keys

| Key | Bytes |
|---|---|
| `F1` … `F4` | `ESC OP` … `ESC OS` (SS3) |
| `Shift+F1` | `ESC [1;2P` (CSI upgraded form) |
| `F5` | `ESC [15~` |
| `F6` | `ESC [17~` |
| `F11` | `ESC [23~` |
| `F12` | `ESC [24~` |
| `Ctrl+F5` | `ESC [15;5~` |

---

## Project layout

```
tui-tester/
├── src/
│   ├── index.ts                    # stdio entrypoint
│   ├── server/
│   │   ├── server.ts               # McpServer assembly
│   │   ├── tools.ts                # 19 tool definitions
│   │   ├── capture.ts              # before/after screen capture
│   │   └── result.ts               # tool-result builders
│   ├── session/
│   │   ├── session-manager.ts      # lifecycle + limits
│   │   ├── terminal-session.ts     # PTY + xterm-headless
│   │   ├── wait.ts                 # wait_for_text / wait_for_idle / hold_key / type_text
│   │   ├── viewer.ts               # visible: true — FIFO + host-terminal viewer
│   │   └── types.ts
│   ├── keys/
│   │   ├── parser.ts               # "ctrl+shift+up" → KeySpec
│   │   ├── encoder.ts              # KeySpec → bytes
│   │   └── types.ts
│   ├── snapshot/
│   │   ├── snapshot.ts             # text / ansi / cells renderers
│   │   └── diff.ts                 # per-row diff
│   └── monitor/
│       └── monitor.ts              # frame-log recorder
├── scripts/
│   ├── demo-tui.mjs                # bundled self-contained demo TUI
│   └── demo-visible.mjs            # live demo driver (visible: true)
└── tests/                          # unit + integration + e2e
    ├── keys/
    ├── session/
    ├── snapshot/
    ├── monitor/
    ├── server/
    └── e2e/
```

---

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc + tsup bundle into dist/
npm test            # run the full test suite
npm run test:e2e    # just the end-to-end tests
npm run dev         # tsup --watch
```

### Try the visible viewer

A self-contained demo TUI (`scripts/demo-tui.mjs`) and a live demo
driver (`scripts/demo-visible.mjs`) ship with the repo, so you can
see the whole thing in action without writing any client code:

```bash
npm run build
node scripts/demo-visible.mjs
```

A real terminal window should pop open on macOS / Linux and mirror
the demo TUI while the driver presses arrow keys and then quits.

### Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, guidelines, and
bug-report tips. PRs welcome.

---

## Architecture notes

**Why `@xterm/headless`?** It's the same emulator state-machine VS Code's integrated terminal uses, so if a TUI renders correctly in VS Code it will render correctly here. Colour, cursor, wide chars, scrollback — everything.

**Why `node-pty` (`@homebridge/node-pty-prebuilt-multiarch`)?** Ships prebuilt binaries for macOS, Linux, and Windows — zero-compile install for end users. Same native PTY layer that mainstream Node-based terminal tools (VS Code's terminal, Hyper, etc.) already rely on, so there's no exotic compilation surface to maintain.

**Why a ring buffer for raw output?** TUIs can produce megabytes of ANSI per second (streaming logs, spinners, etc.). We retain 1 MB by default, configurable; the `@xterm/headless` emulator always has the latest visible screen regardless.

**Why separate `whenParserFlushed()` from `onOutput`?** Calling `terminal.write(data, cb)` with a callback lets us know when the emulator has actually processed the bytes. Snapshots awaited on this cb never race with still-in-flight bytes — you always see the latest state. The rest of the API hides this from callers.

---

## Troubleshooting

**"Session not found" after a `start_session` succeeded.** The response includes a `sessionId` (e.g. `"tui-xxx-1"`); pass *that exact string* as `sessionId`, not the friendly `name`.

**`wait_for_text` times out but the text is clearly there in raw output.** Check whether your TUI is using the alt-screen buffer. Pass `"matchScreen": false` to match against raw bytes instead of the visible grid.

**Process leaks after the MCP server crashes.** Shouldn't happen — SIGINT/SIGTERM/SIGHUP handlers are wired. If it does, send us a reproducer.

**`node-pty` fails to install on ARM Linux.** The homebridge prebuilts cover macOS x64/arm64, Linux x64/arm64, Windows x64. For exotic targets install `node-pty` (source build) in place of the prebuilt package.

---

## License

MIT.
