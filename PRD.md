# PRD — DabiK/ctx

Backlog généré depuis les issues GitHub ouvertes. Chaque item est une tâche.
Coche la case quand la tâche est terminée. Une seule tâche par itération Ralph.

- [x] #2 — Bootstrap CLI, init, prompt and doctor (labels: ready-for-agent)

  **Issue #2 — détail complet**
  > ## Parent
  >
  > Closes no parent issue. Implements part of #1.
  >
  > ## What to build
  >
  > Deliver the first installable `ctx` CLI vertical slice. A developer in a Git repository can run `ctx init`, receive a project configuration and context-ignore template without overwriting existing files, and get the generated LLM protocol prompt in the clipboard. The prompt includes the repository-root `AGENTS.md` when present and reports its absence otherwise. `ctx prompt` and a compact form regenerate that clipboard content. `ctx doctor` reports Git repository, configuration, clipboard, and search-backend readiness with actionable failures.
  >
  > Establish a strict hexagonal architecture: the CLI is an inbound adapter, each `init`, `prompt`, and `doctor` operation is a separate application use case, ports belong to the application layer, and Git/filesystem/clipboard/terminal/OS implementations are outbound infrastructure adapters. Keep the product name, executable name, request marker, response marker, and generated config names derived from one build-time branding source. Remediate any existing flat bootstrap code into this shape before adding behavior.
  >
  > ## Acceptance criteria
  >
  > - [ ] The packaged command starts and provides `init`, `prompt`, and `doctor` help on macOS and Windows.
  > - [ ] `ctx init` only creates missing project configuration/ignore files, copies the generated protocol plus root `AGENTS.md` when present, and never overwrites existing project files without an explicit force option.
  > - [ ] `ctx prompt --compact` produces a smaller valid protocol prompt; neither command creates a prompt file in the project.
  > - [ ] `ctx doctor` reports the Git-repository, clipboard, configuration, and preferred-search status; expected missing prerequisites give an actionable non-zero result.
  > - [ ] Unit tests use fake platform ports rather than a real clipboard.
  > - [ ] Application use cases import only domain/application types and ports; Node and operating-system imports are confined to infrastructure or CLI adapters.
  > - [ ] No god application service combines the three use cases; tests invoke use cases through their public application interfaces.
  >
  > ## Blocked by
  >
  > - None — can start immediately.

- [x] #3 — Safe clipboard file context (labels: ready-for-agent)

  **Issue #3 — détail complet**
  > ## Parent
  >
  > Implements part of #1.
  >
  > ## What to build
  >
  > Deliver the first safe clipboard round trip. A developer can request one or many repository files with `@ctx file` and `@ctx files`, including bounded line ranges, or invoke the equivalent direct commands. ctx returns a stable, LLM-ready response with line numbers and copies it only when requested directly or through the clipboard protocol.
  >
  > This slice establishes the repository permission boundary: Git root detection, `.ctxignore`, configured allowed roots, resolved-link validation, sensitive path/content omission, and clear structured refusal/recovery responses. Direct terminal output remains concise; copied output is the stable protocol response.
  >
  > ## Acceptance criteria
  >
  > - [ ] A valid clipboard request for a file or file list produces an LLM-ready response containing requested paths, selected lines, and configured line numbering.
  > - [ ] Direct reads print to the terminal by default and copy only with `--copy`; protocol-driven reads copy the response.
  > - [ ] Traversal, absolute paths, paths outside configured roots, and links escaping an allowed root are refused without reading or copying content.
  > - [ ] `.ctxignore` exclusions and obvious sensitive content/path checks omit only unsafe items and explain the omission; sensitive disclosure requires an explicit override.
  > - [ ] Parser/security/integration tests exercise requests against temporary Git repositories and fake clipboard ports.
  >
  > ## Blocked by
  >
  > - #2 Bootstrap CLI, init, prompt and doctor.
  >

- [x] #4 — Project discovery and search (labels: ready-for-agent)

  **Issue #4 — détail complet**
  > ## Parent
  >
  > Implements part of #1.
  >
  > ## What to build
  >
  > Extend the safe context loop with project discovery. A developer or LLM can request bounded trees, globs, inspection summaries, and searches through the same protocol and direct CLI. Search prefers ripgrep and uses a Windows-native fallback only when ripgrep is unavailable; both obey the same roots, ignores, result limits, and response contract.
  >
  > ## Acceptance criteria
  >
  > - [ ] Tree, glob, inspect, and search operations are available through direct CLI and `@ctx` requests.
  > - [ ] Tree depth and search/result limits are enforced and explicitly reported when results are limited.
  > - [ ] Inspect returns a bounded directory tree plus the selected principal files and relevant module metadata without exceeding configured limits.
  > - [ ] Ripgrep is used when available; a Windows-native fallback produces compatible bounded results when it is absent.
  > - [ ] All discovery operations honour the established path, allowed-root, `.ctxignore`, and sensitive-content rules.
  >
  > ## Blocked by
  >
  > - #3 Safe clipboard file context.
  >

- [x] #5 — Git context operations (labels: ready-for-agent)

  **Issue #5 — détail complet**
  > ## Parent
  >
  > Implements part of #1.
  >
  > ## What to build
  >
  > Add read-only Git context operations to ctx. A developer or LLM can obtain compact structured status, changed files, working or staged diffs, recent logs, and safe historical show results, optionally scoped to a validated repository path. The operations expose a fixed allowlist of Git behavior and do not become arbitrary Git or shell execution.
  >
  > ## Acceptance criteria
  >
  > - [ ] `status`, `changed`, `diff`, `log`, and `show` work through direct CLI and protocol requests with stable copied sections.
  > - [ ] Status clearly distinguishes staged, modified, untracked, deleted, and branch information.
  > - [ ] Diff supports whole working tree, a validated path, and staged content; log is bounded by default and may be scoped to a validated path.
  > - [ ] Show accepts only safe revision/path forms defined by ctx and refuses arbitrary command fragments.
  > - [ ] Temporary-repository tests cover normal results, empty states, invalid inputs, and non-repository failure behavior.
  >
  > ## Blocked by
  >
  > - #3 Safe clipboard file context.
  >

- [x] #6 — Batch, budgets and recovery (labels: ready-for-agent)

  **Issue #6 — détail complet**
  > ## Parent
  >
  > Implements part of #1.
  >
  > ## What to build
  >
  > Make multi-operation context requests safe and efficient. A developer can use `@ctx batch` to compose supported reads into one response. ctx measures bytes and approximates tokens before copying, applies per-file and total response limits, and turns malformed, denied, or oversized requests into a structured LLM-readable recovery response instead of silently truncating content.
  >
  > ## Acceptance criteria
  >
  > - [ ] A batch executes supported read operations in the declared order and emits one stable response.
  > - [ ] File and total-output budgets fail closed before an oversized context is copied; the copied recovery response identifies costly requested items and asks the LLM to reduce scope.
  > - [ ] Tree, search, and log use explicit capped-result notices rather than pretending the result is complete.
  > - [ ] Byte counts and token estimates are visible in copied context metadata.
  > - [ ] Tests cover mixed batches, malformed nesting, budget boundaries, deterministic estimates, and no-silent-truncation behavior.
  >
  > ## Blocked by
  >
  > - #3 Safe clipboard file context.
  >

- [x] #7 — Controlled writes and sequences (labels: ready-for-agent)

  **Issue #7 — détail complet**
  > ## Parent
  >
  > Implements part of #1.
  >
  > ## What to build
  >
  > Deliver controlled repository modification from tagged LLM proposals. ctx recognises an explicit `@ctx patch` containing one multi-file unified diff and an explicit `@ctx write` containing full-file content. It validates paths and sensitive-write rules, preflights patches with Git, creates necessary directories for accepted full writes, and supports ordered sequences that verify the repository only after a write succeeds.
  >
  > The slice deliberately uses Git as recovery; it does not implement fuzzy repair, partial application, ctx backups, or persistent write history.
  >
  > ## Acceptance criteria
  >
  > - [ ] A tagged multi-file patch is recognised separately from ordinary `ctx diff` read output and is preflighted before any file changes.
  > - [ ] A valid full-file write creates or replaces only a validated non-sensitive path; missing parent directories are created as part of the accepted operation.
  > - [ ] Invalid patches and denied writes change no files and produce a structured diagnostic for the LLM/user.
  > - [ ] A sequence runs its verification reads only after the proposed patch/write succeeds; failures skip later steps and report why.
  > - [ ] Integration tests cover patch success/failure, multiple files, full writes, sensitive-write refusal, and sequence conditional behavior in a temporary Git repository.
  >
  > ## Blocked by
  >
  > - #3 Safe clipboard file context.
  >

- [x] #8 — Watcher TUI: safe and auto (labels: ready-for-agent)

  **Issue #8 — détail complet**
  > ## Parent
  >
  > Implements part of #1.
  >
  > ## What to build
  >
  > Deliver the foreground `ctx watch` mini-TUI in safe and auto modes. It observes clipboard changes, ignores ctx’s own responses and duplicate clipboard content, displays current mode and recent events, accepts manual read commands, and copies their structured results. It surfaces tagged patch/write proposals with preview and an explicit application action, while keeping all activity visible in the foreground terminal.
  >
  > ## Acceptance criteria
  >
  > - [ ] `ctx watch` launches a keyboard-operable foreground TUI showing mode, recent events, pending proposed writes, and the latest copied response.
  > - [ ] Safe mode confirms read requests and proposed writes; auto mode runs valid reads automatically but keeps writes awaiting an explicit TUI action.
  > - [ ] The TUI command entry executes supported read operations and automatically copies their structured response.
  > - [ ] Watcher loop prevention ignores `# CTX RESPONSE` and duplicate clipboard hashes.
  > - [ ] Deterministic watcher/TUI tests use fake clipboard and clock ports to cover events, mode transitions, pending-write preview, application, and cancellation.
  >
  > ## Blocked by
  >
  > - #4 Project discovery and search.
  > - #5 Git context operations.
  > - #6 Batch, budgets and recovery.
  > - #7 Controlled writes and sequences.
  >

- [x] #9 — Yolo user mode and notifications (labels: ready-for-agent)

  **Issue #9 — détail complet**
  > ## Parent
  >
  > Implements part of #1.
  >
  > ## What to build
  >
  > Complete the fast interactive workflow. Add the user-local persisted `yolo` mode and optional desktop notifications. In yolo, a valid visible patch or full-write proposal enters a three-second countdown in the TUI and applies only if the user does not cancel it. The project never stores this personal mode, so collaborators do not inherit an automation preference.
  >
  > ## Acceptance criteria
  >
  > - [ ] The selected mode is persisted in user-local configuration, outside the repository, and restored by a later watcher session.
  > - [ ] In yolo, valid non-sensitive patch and full-write proposals display a cancellable three-second countdown and apply only after it completes.
  > - [ ] Sensitive writes remain blocked even in yolo unless the explicit sensitive-write override is provided.
  > - [ ] Optional notifications report request completion and pending/applied write events without replacing TUI diagnostics.
  > - [ ] Tests cover persisted mode restore, countdown completion/cancellation, sensitive-write refusal, and notification-port behavior with fakes.
  >
  > ## Blocked by
  >
  > - #8 Watcher TUI safe and auto.
  >

- [x] #10 — Package, cross-platform CI and E2E (labels: ready-for-agent)

  **Issue #10 — détail complet**
  > ## Parent
  >
  > Implements part of #1.
  >
  > ## What to build
  >
  > Make ctx distributable and prove the full clipboard workflow on both supported platforms. Package the Node CLI for npm installation, document prerequisites and the `ctx doctor` recovery path, and run end-to-end fixture tests on macOS and Windows. The scenario covers init/prompt, a clipboard context round trip, a tagged multi-file change, and TUI-mediated verification.
  >
  > ## Acceptance criteria
  >
  > - [ ] The package exposes the `ctx` executable through npm and documents installation plus all required platform prerequisites.
  > - [ ] macOS and Windows CI execute the supported fixture workflow; Windows verifies the search fallback when ripgrep is unavailable.
  > - [ ] The end-to-end scenario covers initial prompt copying, context request/response, a multi-file patch or full write, post-write verification, and a visible failure case.
  > - [ ] Documentation clearly distinguishes supported macOS/Windows behavior from future platform work.
  > - [ ] Release verification includes `ctx doctor` output for a ready and a missing-prerequisite environment.
  >
  > ## Blocked by
  >
  > - #2 Bootstrap CLI, init, prompt and doctor.
  > - #4 Project discovery and search.
  > - #5 Git context operations.
  > - #6 Batch, budgets and recovery.
  > - #7 Controlled writes and sequences.
  > - #9 Yolo user mode and notifications.
  >

- [x] #11 — OpenTUI watcher interface (labels: ready-for-agent)

  **Issue #11 — détail complet**
  > ## Parent
  >
  > Implements part of #1.
  >
  > ## What to build
  >
  > Replace the current hand-rendered watcher terminal interface with a polished, keyboard-operable OpenTUI interface. Preserve the existing watcher, clipboard, write, security, and application-use-case behaviour: this is a platform rendering-adapter migration, not a workflow rewrite. The interface must make mode, recent activity, pending proposal, preview, yolo countdown, and available actions immediately legible on macOS and Windows terminals.
  >
  > ## Acceptance criteria
  >
  > - [ ] `ctx watch` renders through OpenTUI with a responsive full-screen layout: clear status/mode header, recent activity, pending write state, and persistent keyboard-help area.
  > - [ ] Safe, auto, and persisted yolo mode are visually distinct; a yolo countdown is visible and cancellation remains obvious.
  > - [ ] Pending patch/write previews are readable without losing the proposal or its target summary.
  > - [ ] All existing keyboard actions remain operable and their focus/selection state is visible.
  > - [ ] A dedicated TUI action copies the same startup protocol as `ctx prompt`, including root `AGENTS.md` when present, without creating or overwriting `.ctx.toml` or `.ctxignore`.
  > - [ ] The application layer and watcher policy remain independent of OpenTUI; OpenTUI stays in a replaceable platform adapter.
  > - [ ] Tests preserve deterministic watcher behaviour through the existing TUI port/fake, and a manual smoke path documents rendering on macOS and Windows.
  >
  > ## Blocked by
  >
  > - #9 Yolo user mode and notifications.
