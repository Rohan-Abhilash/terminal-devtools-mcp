# Contributing to tui-tester

Thanks for taking the time to contribute! This project is a Model
Context Protocol (MCP) server that gives AI agents programmatic
control of terminal user interfaces. Patches, bug reports, and
suggestions are all welcome.

## Getting set up

```bash
git clone https://github.com/Rohan-Abhilash/terminal-devtools-mcp.git
cd terminal-devtools-mcp
npm install
npm run build
npm test
```

Node 18 or newer is required. `@homebridge/node-pty-prebuilt-multiarch`
ships prebuilt binaries for macOS (x64/arm64), Linux (x64/arm64), and
Windows (x64) so no compilation toolchain is needed for those targets.

## Development workflow

```bash
npm run typecheck   # tsc --noEmit (zero-cost check)
npm run build       # tsc + tsup bundle into dist/
npm run dev         # tsup --watch for iterative development
npm test            # run the full test suite
npm run test:watch  # re-run tests on file change
npm run test:e2e    # run only the end-to-end tests
```

All code is TypeScript (`strict: true`). Runtime schema validation is
handled with [Zod](https://zod.dev). The public tool surface is defined
in `src/server/tools.ts`; each tool exports a Zod `inputSchema`, and
the SDK parses and validates incoming arguments before your handler is
called.

## Project layout

```
src/
  index.ts            # MCP stdio entrypoint
  server/             # McpServer + tool definitions + result helpers
  session/            # PTY lifecycle, visible viewer, typed waits
  keys/               # "ctrl+shift+up" → bytes parser/encoder
  snapshot/           # @xterm/headless → text / ansi / cells / diff
  monitor/            # frame-log recorder
tests/                # jest tests (unit, integration, e2e)
scripts/
  demo-tui.mjs        # bundled self-contained demo TUI
  demo-visible.mjs    # live demo of visible: true against demo-tui
```

## Guidelines

- **Keep the code compact.** Existing code collapses duplicate
  branches, prefers shared helpers over repetition, and documents
  non-obvious invariants with short comments. Please match that style.
- **Tests are mandatory** for bug fixes and new features. Favour the
  smallest unit test that captures the behaviour; reach for an e2e
  test when the bug only surfaces at the PTY boundary.
- **Don't break the tool contract** on a patch release. If a change to
  a tool's input/output schema is needed, call it out in the PR and
  the changelog.
- **Follow Conventional Commits** for commit messages
  (`feat:`, `fix:`, `docs:`, `chore:`, etc.). It keeps changelog
  generation sane.
- **Run the full suite before opening a PR.** Long-running e2e tests
  catch regressions that unit tests miss.

## Reporting bugs

Please include:

- The version of tui-tester (from `package.json`).
- The version of Node (`node --version`) and your OS.
- A minimal reproducer — ideally a Jest test against
  `SessionManager` + a short TUI script.
- The full stack trace or the MCP response body.

## License

By contributing, you agree that your contributions will be licensed
under the project's [MIT license](./LICENSE).
