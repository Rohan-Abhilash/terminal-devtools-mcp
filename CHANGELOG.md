# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

### Added

- Initial public release of the tui-tester MCP server.
- 20 MCP tools covering session lifecycle, input, output, waiting,
  monitoring, and resizing:
    - `start_session`, `stop_session`, `list_sessions`
    - `run_script`
    - `send_keys`, `send_text`, `send_raw`, `hold_key`, `type_text`
    - `snapshot`, `get_text`, `get_cursor`, `get_raw_output`, `get_exit_info`
    - `wait_for_text`, `wait_for_idle`
    - `start_monitor`, `stop_monitor`, `diff_snapshots`
    - `resize`
- Every input tool returns a `screen` block with before/after text +
  row-level diff out of the box.
- Every input tool (`send_keys`, `send_text`, `send_raw`, `hold_key`,
  `type_text`) accepts an optional `waitFor` spec — submit the input
  AND block until a specific pattern appears on screen in a single
  round-trip. The `after` snapshot is timed to the exact frame the
  pattern first matched, so agents never miss transient post-input
  states that would otherwise disappear before a follow-up
  `wait_for_text` call could reach them. Supports literal substrings
  and regular expressions (with capture groups).
- `run_script` executes multi-step input/wait/assert/snapshot flows inside
  one MCP tool call, with optional whole-script frame monitoring and raw
  output capture to remove round-trip races.
- Optional `visible: true` viewer window that mirrors the PTY into a
  real OS terminal on macOS and Linux.
- Full `includeScrollback` support on `snapshot` / `get_text` — the
  entire terminal output buffer is available on demand, including the
  hidden normal buffer when the session is using the alt-screen.
- Bundled self-contained demo TUI (`scripts/demo-tui.mjs`) and a live
  demo driver (`scripts/demo-visible.mjs`).
- End-to-end test suite covering the demo TUI, screen capture, and the
  full MCP tool surface.
