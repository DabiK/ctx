# Smoke path — OpenTUI watcher interface (PRD #11)

`ctx watch` renders through OpenTUI (`@opentui/core`), a native Zig-core
terminal UI with Flexbox layout, keyboard parsing, and incremental rendering.
The application watcher (`WatchUseCase`) and its policy stay fully independent
of OpenTUI: every OpenTUI call lives in the `SystemTui` platform adapter
(`src/platform/tui.ts`), behind the `TuiPort` contract. Deterministic watcher
behaviour is covered by the unit suites in `src/tests/watch.test.ts` through
the scripted `FakeTui`; this document is the manual smoke path that exercises
the real OpenTUI rendering.

## Runtime prerequisite

OpenTUI loads its native library through FFI. Supported runtimes:

- **Bun 1.3+** — bundles `bun:ffi` and loads the matching optional native
  package (`@opentui/core-darwin-arm64`, `-win32-x64`, …).
- **Node.js 26.4.0 exactly** — must be started with `--experimental-ffi`.

On any other runtime `ctx watch` refuses to start with an actionable message
(e.g. `bun ctx watch`). Run the watcher from a checkout with:

```sh
bun dist/cli.js watch            # macOS and Linux
bun dist/cli.js watch --allow-sensitive
```

Windows shells (PowerShell / cmd) run the same command with `bun` on PATH.

## What to look for

The full-screen layout must show, top to bottom:

1. **Status/mode header** — a bordered box titled `ctx — clipboard watcher`
   with the current mode in color: green `SAFE`, blue `AUTO`, amber `YOLO`.
   In yolo a countdown line appears in red:
   `>> Applying Write proposal in Ns — press any key to cancel`.
2. **Recent activity** — the event log (flex-grows with the terminal height;
   older events collapse into a `… (N older events)` note).
3. **Pending proposed writes** — each pending `@ctx patch/write/sequence` with
   its target list and validation status note, or `(none)`.
4. **Latest copied response** — the most recent `# CTX RESPONSE` block,
   truncated with a `… (N more lines)` note (full text stays in the preview).
5. **Keys footer** — the persistent keyboard-help box (`m`, `e`, `a`, `c`,
   `p`, `i`, `q`).

The layout must survive terminal resizes (Flexbox reflows; no static frame).

## macOS smoke path

Prerequisite: `bun` on PATH, `pbcopy`/`pbpaste` available, and a terminal
that supports VT sequences (Terminal.app, iTerm2, VS Code terminal, …).

```sh
mkdir -p /tmp/ctx-smoke && cd /tmp/ctx-smoke
git init -q && git config user.email t@t && git config user.name t
printf 'hello world\n' > hello.txt
git add hello.txt && git commit -qm init
bun /path/to/ctx-checkout/dist/cli.js watch
```

Then, in a second terminal:

1. `printf '@ctx file hello.txt' | pbcopy` — the watcher shows the safe-mode
   confirm row (`Run file hello.txt? (y/n)`); answer `y`. The clipboard now
   holds a `# CTX RESPONSE` with the file and line numbers, and the response
   box updates.
2. `printf '@ctx write hello.txt\n```\nhello world\nline two\n```' | pbcopy`
   — the proposal surfaces under *Pending proposed writes*. Press `p` for the
   full-screen preview overlay (any key closes it), `a` to apply after the
   safe-mode confirm (`y`), `c` to cancel. After `a`+`y` the file gains
   `line two` and the apply response is copied.
3. Press `m` twice to reach **yolo**. Copy a new write proposal and watch the
   red three-second countdown auto-apply it; press any key during the
   countdown to cancel it (the file stays unchanged and the proposal remains
   pending). Sensitive writes (`.env`, …) stay blocked in yolo without
   `--allow-sensitive`.
4. Press `e`, type `status`, press Enter — a `# CTX RESPONSE` status block is
   copied.
5. Press `i` — the startup protocol (the `ctx prompt` content plus the root
   `AGENTS.md` when present) is copied to the clipboard; a second poll ignores
   it as duplicate content (loop prevention), and no `.ctx.toml`/`.ctxignore`
   file appears in the repository. Press `q` (or Ctrl-C) to quit; the terminal
   is restored.

## Windows smoke path

Prerequisite: `bun` on PATH (install via `bun.sh` or `winget install
Oven-sh.Bun`), PowerShell available (system clipboard via `Set-Clipboard` /
`Get-Clipboard`), and a terminal that supports VT sequences (Windows Terminal,
conhost on Windows 10+).

In a PowerShell terminal:

```powershell
Set-Location C:\temp\ctx-smoke
git init -q; git config user.email t@t; git config user.name t
"hello world" | Set-Content hello.txt
git add hello.txt; git commit -qm init
bun C:\path\to\ctx\checkout\dist\cli.js watch
```

In a second PowerShell window, use `Set-Clipboard` for the same `@ctx file`,
`@ctx write`, mode-cycle, countdown, and command-entry steps as above
(`Get-Clipboard` shows the copied `# CTX RESPONSE`).

Windows note: OpenTUI ships a `@opentui/core-win32-x64` optional package; if
the watcher reports a missing native library, reinstall with optional
dependencies enabled (`npm ci` / `bun install` with the default settings).

## Regression checklist

- [ ] `ctx watch` renders the bordered full-screen layout on macOS (Terminal.app
      and iTerm2) and Windows (Windows Terminal).
- [ ] Safe, auto, and yolo are visually distinct; the yolo countdown is visible
      and any key cancels it.
- [ ] `p` opens the full proposal preview without losing the pending entry.
- [ ] `m`, `e`, `a`, `c`, `p`, `i`, `q` keep working; focus (command row) is visible.
- [ ] `i` copies the startup protocol (protocol + root AGENTS.md when present)
      and creates/overwrites neither `.ctx.toml` nor `.ctxignore`; the next
      poll ignores the copied prompt (loop prevention).
- [ ] Loop prevention still ignores `# CTX RESPONSE` and duplicate clipboard
      hashes (event log shows the ignored lines).
- [ ] `bun dist/cli.js watch` under an unsupported Node version exits non-zero
      with the actionable runtime message.