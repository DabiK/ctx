# ctx

`ctx` is a local repository context runtime: a narrow CLI and foreground
watcher that executes a controlled set of repository operations for an LLM
chat, with the **clipboard as the transport** and the human as the permission
boundary. See [CONTEXT.md](CONTEXT.md) for the product vocabulary.

Supported platforms: **macOS** and **Windows** (see
[Platform support](#platform-support)).

## Installation

The package publishes the `ctx` executable through npm:

```sh
npm install -g ctx-cli
```

Node.js **>= 18** is required. The packaged command is a plain Node script —
no native build step for the core CLI. To install from a local checkout
instead of the registry:

```sh
npm pack                 # produces ctx-cli-<version>.tgz
npm install -g ./ctx-cli-<version>.tgz
```

## Prerequisites

| Capability | macOS | Windows |
| --- | --- | --- |
| Git repository | `git` on PATH | `git` on PATH |
| Clipboard | `pbcopy` / `pbpaste` (built in) | Windows PowerShell 5.1+ (`Set-Clipboard` / `Get-Clipboard`, built in) |
| Search (preferred) | `rg` (ripgrep) — `brew install ripgrep` | `rg` — optional |
| Search (fallback) | — | `findstr` (built in) — used only when ripgrep is absent |
| `ctx watch` TUI | Bun 1.3+ **or** Node.js 26.4.0 with `--experimental-ffi` (OpenTUI FFI runtime) | same |

Missing prerequisites are reported by `ctx doctor` with the exact recovery
command (see below).

## Quick start

```sh
# 1. Project setup — creates .ctx.toml + .ctxignore (never overwrites without
#    --force), then copies the LLM protocol prompt (plus the root AGENTS.md
#    when present) to the clipboard.
ctx init

# 2. Health check — Git repository, configuration, clipboard, search backend.
ctx doctor

# 3. Ask the LLM to emit @ctx requests (file, tree, search, status, diff, ...),
#    paste them into the clipboard, then run:
ctx read               # executes the @ctx request and copies # CTX RESPONSE back

# 4. Apply a tagged @ctx patch / @ctx write / @ctx sequence proposal:
ctx read               # validates + preflights, copies a preview, changes nothing
ctx apply              # the explicit approval that applies the proposal

# 5. Or keep the loop foregrounded:
ctx watch              # safe / auto / yolo clipboard watcher TUI
```

Run `ctx --help` for the full command list and per-command options.

## `ctx doctor` recovery path

`ctx doctor` exits `0` only when every expected prerequisite is present.
Failures are actionable:

- **Not inside a Git repository** — `ctx` requires one: run `git init` (or
  open an existing checkout), then `ctx init`.
- **`.ctx.toml` not present** — a warning: run `ctx init` to create the
  default configuration and ignore files.
- **Clipboard backend not available** — on macOS `pbcopy` must be on PATH
  (shipped at `/usr/bin/pbcopy`); on Windows `powershell.exe` (shipped in
  `System32\WindowsPowerShell`).
- **ripgrep not found** — on macOS search requires ripgrep: `brew install
  ripgrep`; on Windows the native `findstr` fallback is used instead and this
  stays a warning, not a failure.

See [docs/release.md](docs/release.md) for verified `ctx doctor` output of a
ready environment and of environments with missing prerequisites.

## Protocol round trip

- **request**: an `@ctx` block (e.g. `@ctx file src/app.ts:1-40`,
  `@ctx search "TODO"`, `@ctx status`, `@ctx batch`, `@ctx patch` + unified
  diff, `@ctx write <path>` + body, `@ctx sequence`).
- **response**: a stable `# CTX RESPONSE` block copied back, with line
  numbers, byte/token metadata, explicit `limited` notices, and structured
  refusals instead of silent truncation.

Direct commands (`ctx file`, `ctx status`, `ctx diff`, ...) print concise
terminal output and copy the same stable block only with `--copy`.

## Platform support

The current MVP supports **macOS** and **Windows** end to end:

- Clipboard adapters: `pbcopy`/`pbpaste` (macOS) and PowerShell
  `Set-Clipboard`/`Get-Clipboard` (Windows).
- Search: ripgrep when available, the Windows-native `findstr` fallback when
  it is not.
- The watcher renders through OpenTUI on both platforms (Bun 1.3+ or the
  Node.js 26.4.0 FFI runtime).

Future platform work (not part of this MVP): Linux clipboard/notification
adapters, Windows package signing, and ARM Linux builds. Unsupported platforms
reject with an actionable message (`ctx doctor` explains what is missing).

### Test/automation hook

Setting `CTX_CLIPBOARD_FILE=/path/to/file` redirects clipboard reads and
writes to that plain file instead of the system clipboard. This is an
infrastructure-only hook for deterministic end-to-end runs on headless CI; it
is not part of the user-facing protocol and has no effect on application
behavior.

## Development

```sh
npm ci
npm run typecheck      # TypeScript strict typecheck
npm test               # build + unit/integration suites (fake platform ports)
npm run e2e            # packaged-CLI end-to-end fixture workflow (temp repo + file clipboard)
npm run pack:check     # npm pack → install the tarball → run the installed ctx bin
```

GitHub Actions CI (`.github/workflows/ci.yml`) runs the typecheck, the test
suite, the package check, and the end-to-end fixture workflow on **macOS** and
**Windows** matrix runners; the Windows job verifies the `findstr` search
fallback with ripgrep hidden from PATH.

## Documentation

- [docs/specs/ctx-mvp.md](docs/specs/ctx-mvp.md) — MVP specification.
- [docs/tickets/](docs/tickets/) — per-issue implementation tickets.
- [docs/smoke-opentui.md](docs/smoke-opentui.md) — manual `ctx watch` smoke
  path on macOS and Windows.
- [docs/release.md](docs/release.md) — release verification checklist.
- [docs/agents/](docs/agents/) — issue tracker, triage labels, and domain
  notes for the autonomous delivery loop.