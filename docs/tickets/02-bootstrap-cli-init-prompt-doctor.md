## Parent

Closes no parent issue. Implements part of #1.

## What to build

Deliver the first installable `ctx` CLI vertical slice. A developer in a Git repository can run `ctx init`, receive a project configuration and context-ignore template without overwriting existing files, and get the generated LLM protocol prompt in the clipboard. The prompt includes the repository-root `AGENTS.md` when present and reports its absence otherwise. `ctx prompt` and a compact form regenerate that clipboard content. `ctx doctor` reports Git repository, configuration, clipboard, and search-backend readiness with actionable failures.

Establish a strict hexagonal architecture: the CLI is an inbound adapter, each `init`, `prompt`, and `doctor` operation is a separate application use case, ports belong to the application layer, and Git/filesystem/clipboard/terminal/OS implementations are outbound infrastructure adapters. Keep the product name, executable name, request marker, response marker, and generated config names derived from one build-time branding source. Remediate any existing flat bootstrap code into this shape before adding behavior.

## Acceptance criteria

- [ ] The packaged command starts and provides `init`, `prompt`, and `doctor` help on macOS and Windows.
- [ ] `ctx init` only creates missing project configuration/ignore files, copies the generated protocol plus root `AGENTS.md` when present, and never overwrites existing project files without an explicit force option.
- [ ] `ctx prompt --compact` produces a smaller valid protocol prompt; neither command creates a prompt file in the project.
- [ ] `ctx doctor` reports the Git-repository, clipboard, configuration, and preferred-search status; expected missing prerequisites give an actionable non-zero result.
- [ ] Unit tests use fake platform ports rather than a real clipboard.
- [ ] Application use cases import only domain/application types and ports; Node and operating-system imports are confined to infrastructure or CLI adapters.
- [ ] No god application service combines the three use cases; tests invoke use cases through their public application interfaces.

## Blocked by

- None — can start immediately.
