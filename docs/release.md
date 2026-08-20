# Release verification (PRD #10)

Checklist for releasing a new `ctx` version to npm, with the automated
verification commands and the `ctx doctor` output for a ready and for
missing-prerequisite environments.

## Automated gates

Every gate must pass before publishing:

```sh
npm ci
npm run typecheck
npm test                 # unit + integration suites (fake platform ports)
npm run pack:check       # npm pack → install the tarball → run the installed ctx bin
npm run e2e              # packaged-CLI end-to-end fixture workflow
```

CI (`.github/workflows/ci.yml`) runs all four gates on the **macOS** and
**Windows** matrix; the end-to-end workflow covers initial prompt copying,
clipboard context round trips, a tagged multi-file patch (preview + apply),
post-write verification, visible failure cases, and the Windows `findstr`
search fallback with ripgrep hidden from PATH. `npm publish` itself runs the
same gates through `prepublishOnly`.

## Release checklist

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes (all unit + integration suites).
- [ ] `npm run pack:check` passes: the tarball installs and `ctx --version`
      prints the release version; `ctx --help` shows usage; `ctx doctor`
      outside a repository exits non-zero with the recovery message.
- [ ] `npm run e2e` passes on macOS and Windows CI.
- [ ] `ctx doctor` in a ready environment prints `all checks passed` and exits
      0.
- [ ] `ctx doctor` in a missing-prerequisite environment exits non-zero and
      prints the actionable recovery path.
- [ ] `npm publish` (the `prepublishOnly` gates run automatically).

## `ctx doctor` output — ready environment (macOS)

Verified against `ctx 0.1.0` with Git, `pbcopy`, and ripgrep available:

```text
[ok] Git repository found at <repo root>
[warn] .ctx.toml not present — run `ctx init` to create the default configuration.
[ok] Clipboard backend available (pbcopy)
[ok] ripgrep found — preferred search backend ready
ctx doctor: all checks passed.
```

Exit code: `0`. (Run `ctx init` once to turn the `.ctx.toml` warning into an
`[ok]`.)

## `ctx doctor` output — missing prerequisite: no Git repository

```text
[fail] Not inside a Git repository — ctx requires one. Run `git init` (or open an existing checkout) and then `ctx init`.
[warn] Configuration not checked (no repository root).
[ok] Clipboard backend available (pbcopy)
[ok] ripgrep found — preferred search backend ready
ctx doctor: one or more prerequisites are missing — see the failures above.
```

Exit code: `1`. The recovery path is spelled out in the failure line.

## `ctx doctor` output — missing prerequisite: no ripgrep (macOS)

```text
[ok] Git repository found at <repo root>
[warn] .ctx.toml not present — run `ctx init` to create the default configuration.
[ok] Clipboard backend available (pbcopy)
[fail] ripgrep not found — search requires it on this platform. Install ripgrep (e.g. `brew install ripgrep`) or rerun `ctx doctor`.
ctx doctor: one or more prerequisites are missing — see the failures above.
```

Exit code: `1`. On **Windows** the same missing ripgrep is only a warning
("ripgrep not found — the Windows-native search fallback will be used.") and
`ctx doctor` exits `0`, because `findstr` keeps search working there.

## End-to-end scenario (what `npm run e2e` proves)

Against a fresh temporary Git repository with the clipboard redirected to a
file (`CTX_CLIPBOARD_FILE`):

1. `ctx init` creates `.ctx.toml` + `.ctxignore` and copies the startup
   protocol including the root `AGENTS.md`.
2. `ctx prompt --compact` copies a smaller valid protocol prompt.
3. `@ctx file` and combined `@ctx status` + `@ctx file` requests round-trip a
   `# CTX RESPONSE` with line numbers back to the clipboard.
4. `@ctx search` returns matching lines through the protocol.
5. A tagged multi-file `@ctx patch` is previewed by `ctx read` (no files
   change), then applied by `ctx apply`.
6. Post-write verification: `@ctx status` + `@ctx diff` confirm the change.
7. Visible failure cases: a traversal request is refused without leaking
   content, and `ctx apply` without a proposal copies a structured refusal.
8. On Windows, search still works through the `findstr` fallback with ripgrep
   hidden from PATH; elsewhere a missing ripgrep yields the actionable error.

The watcher's TUI-mediated verification is exercised deterministically by the
`WatchUseCase` unit suites (scripted `TuiPort` fakes) and manually through
[docs/smoke-opentui.md](smoke-opentui.md).