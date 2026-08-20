# ctx MVP specification

## Problem Statement

Developers using a web LLM chat must repeatedly copy repository context into the chat and copy its suggestions back to the local project. The chat has no direct filesystem or tool access, which is safer but makes the workflow slow and error-prone. Existing coding agents solve this by granting broad machine access; the user needs a lighter alternative where the clipboard is the transport, the human remains the permission boundary, and only an explicit local runtime can touch the repository.

## Solution

Build `ctx`, a TypeScript/Node.js CLI for macOS and Windows. It operates only from a Git repository, parses a small `@ctx` protocol from the clipboard or direct commands, and produces stable LLM-ready context responses. It provides repository read operations, controlled full writes and unified patches, a foreground interactive watcher/TUI, context limits, sensitive-content protections, and a project prompt bootstrap.

The core user loop is: copy an `@ctx` request from the web LLM, let `ctx` obtain only the allowed local information and copy a response, paste it into the chat, copy a tagged change proposal, then review or apply it through ctx. `ctx watch` makes this loop fast without giving the LLM a direct connection to the machine.

## User Stories

1. As a developer, I want to initialise ctx in a Git repository, so that the project has explicit context and ignore rules.
2. As a developer, I want `ctx init` to copy the communication prompt and root `AGENTS.md` into my clipboard, so that I can start a correctly instructed chat immediately.
3. As a developer, I want `ctx init` to preserve existing configuration files, so that rerunning setup never destroys project choices.
4. As a developer, I want a compact prompt command, so that I can prepare a new chat without repeating setup.
5. As a developer, I want to request one file or a bounded range of lines, so that I share only needed context.
6. As a developer, I want to request several files in one request, so that the LLM can understand a related change efficiently.
7. As a developer, I want line numbers in shared code by default, so that the LLM can refer precisely to code.
8. As a developer, I want to browse a tree with depth limits, so that the LLM can discover a project without receiving every file.
9. As a developer, I want to search through the project with ripgrep-quality results and a Windows-native fallback, so that search works on both supported systems.
10. As a developer, I want glob and inspect operations, so that the LLM can discover relevant files without a giant tree.
11. As a developer, I want structured Git status, changed-file lists, diffs, logs, and historical show operations, so that the LLM understands current and recent repository state.
12. As a developer, I want to combine reads in a batch, so that one round trip supplies all required context.
13. As a developer, I want every copied response to have stable headings and metadata, so that the LLM distinguishes it from ordinary chat text.
14. As a developer, I want a visible estimate and strict budget before large context is copied, so that a chat context window is not accidentally overwhelmed.
15. As a developer, I want an oversized request to return an LLM-readable instruction to reduce scope, so that the next LLM response can recover without guessing.
16. As a developer, I want explicit output limits for search, tree, and log, so that their stated truncation is safe and predictable.
17. As a developer, I want `.ctxignore` to control context exclusion, so that the project can declare files never intended for the LLM.
18. As a developer, I want sensitive paths and obvious secrets withheld from outbound context, so that accidental clipboard sharing is reduced.
19. As a developer, I want sensitive writes rejected by default, so that an LLM cannot overwrite credentials it could not inspect.
20. As a developer, I want explicitly configured external allowed roots, so that related local folders can be read without giving unrestricted machine access.
21. As a developer, I want ctx to reject paths outside allowed roots and malformed requests, so that the protocol has a reliable permission boundary.
22. As a developer, I want to copy one tagged multi-file patch from the LLM, so that ctx can distinguish a proposed change from an ordinary `git diff` response.
23. As a developer, I want a tagged full-file write, so that a change remains possible when a line-sensitive patch no longer applies.
24. As a developer, I want a sequence to write and then return verification reads only if the write succeeds, so that the LLM can check its own change in one clipboard round trip.
25. As a developer, I want patches preflighted with Git before modification, so that an invalid patch changes no files.
26. As a developer, I want a foreground watcher with a compact TUI, so that I can see what clipboard requests and proposed changes are doing.
27. As a developer, I want `safe`, `auto`, and `yolo` modes, so that the level of confirmation matches the task I am doing.
28. As a developer, I want `yolo` to persist in user-local configuration and to show a cancellable three-second countdown before writing, so that fast operation is deliberate and visible.
29. As a developer, I want to execute read commands from the TUI and have their results copied automatically, so that the TUI is a practical local cockpit.
30. As a developer, I want desktop notifications to be optional, so that the watcher remains usable without relying on them.
31. As a developer, I want `ctx doctor` to diagnose Git, clipboard, search, repository, and configuration readiness, so that setup failures are actionable.
32. As a developer, I want direct CLI commands to print concise terminal output and copy only with `--copy`, so that normal terminal use does not overwrite my clipboard.

## Implementation Decisions

- The public product name and protocol namespace are `ctx`: the executable is `ctx`, the request marker is `@ctx`, and copied responses start with `# CTX RESPONSE`. Brand-derived names come from one build-time source of truth.
- The runtime is TypeScript on Node.js. It supports macOS and Windows through operating-system adapters for clipboard, notifications, and the watcher. Clipboard mocks are used for unit tests.
- ctx requires a Git repository. Repository root discovery is a core boundary; Git features are not silently simulated.
- Project configuration is `.ctx.toml`; project context exclusions are `.ctxignore`. `.ctxignore`, not `.gitignore`, decides ordinary context exclusions. The init template contains prudent generated-artifact and sensitive-file entries.
- User-local configuration, outside the repository, stores the persisted watcher mode. `yolo` may persist there; it must never be inherited by collaborators through project configuration.
- A read path must resolve within the repository root or an explicit `allowed_roots` entry. Symbolic links are allowed only when their resolved target is inside an allowed root. Absolute paths and traversal outside allowed roots are refused.
- Read commands are a fixed allowlist: tree, file, files, search, glob, inspect, status, changed, diff, log, and show. No arbitrary shell operation is exposed to the LLM.
- Requests support direct CLI syntax and clipboard protocol syntax. Batches compose read operations. A sequence can contain a patch or full write followed by reads; later reads run only after the write succeeds.
- A patch is an explicit `@ctx patch` block containing one unified diff, potentially for many files. Raw ordinary Git diffs are read output, not ambiguous write instructions. Multiple tagged write proposals require a deliberate selection.
- A full write is an explicit `@ctx write <relative-path>` block with a plain fenced complete file body. Missing parent directories are created only after path and sensitive-write validation.
- Patches use `git apply --check` before application. ctx does not repair failing patches or apply partial changes. Git is the MVP recovery mechanism; no ctx backup, history, or session store is implemented.
- The architecture is strict hexagonal: CLI/TUI are inbound adapters; each behavior is an application use case; application ports are the only external dependencies; Git, filesystem, clipboard, terminal, notification, clock, and OS code are outbound infrastructure adapters. Tests cross use-case interfaces with fakes. Do not use a god application service.
- Outbound context uses a stable formatter, configured line numbering, byte accounting, and approximate token estimates. File and total-output limits fail closed. Tree/search/log may explicitly report their own result cap.
- Sensitive outbound detection covers excluded sensitive paths and a deliberately small set of high-signal content patterns. It removes the sensitive item, preserves safe requested items, and explains the omission. An explicit user override is required for sensitive disclosure or writing.
- `ctx watch` is a foreground interactive TUI, not an installed background service. It shows the current mode, recent events, pending writes, an event log, a command entry, and the latest copied response. TUI reads copy their structured response automatically.
- In safe mode every requested action is confirmed. In auto mode reads run automatically but writes wait in the TUI. In yolo mode valid writes enter a visible, cancellable three-second countdown. Clipboard write proposals are surfaced in the TUI; they are not silently acted on outside its visible lifecycle.
- Invalid, denied, malformed, or over-budget clipboard requests produce a structured response with the reason and a safe next request. They do not modify files.

## Testing Decisions

- Tests assert observable protocol and repository behavior, not private implementation structure.
- Parser tests cover every read command, line ranges, options, batches, sequences, malformed blocks, duplicate write proposals, and protocol-response loop prevention.
- Security tests cover traversal, absolute paths, allowed roots, symlink resolution, `.ctxignore`, sensitive path/content detection, and sensitive-write overrides.
- Context tests cover line numbering, byte and token budgets, oversized recovery responses, range handling, and explicit truncation notices.
- Repository integration tests use temporary Git repositories to exercise status, changed, diff, log, show, patch preflight, patch success, patch failure, and full writes.
- Application-service integration tests use fake clipboard, clock, terminal, notification, and filesystem/repository ports to verify clipboard-to-response and write-then-verify sequences.
- TUI/watcher tests use deterministic clipboard event and clock fakes to verify loop prevention, duplicate hashes, mode transitions, countdown cancellation, and read-copy behavior.
- End-to-end smoke tests run the packaged CLI against a fixture Git repository on macOS and Windows CI, including the Windows search fallback when ripgrep is unavailable.

## Out of Scope

- LLM APIs, MCP, model-managed shell access, browser automation, injection into a web chat, autonomous agents, automatic test execution requested by the LLM, embeddings, vector databases, RAG, AST/LSP/Tree-sitter analysis, fuzzy patch repair, and silent modifications without the selected watcher-mode behavior.
- Persistent ctx history, session memory, stale-file tracking, and ctx-managed backups. Git is the recovery mechanism for the MVP.
- A background service, an integrated code editor, Git client, or chat client in the TUI.
- Linux support in the MVP, while the architecture keeps operating-system concerns isolated for later expansion.

## Further Notes

- `ctx doctor` is a distribution feature, not an afterthought. It reports the repository, Git, clipboard, search backend, configuration, and platform adapter status in an actionable way.
- The generated LLM prompt must teach the protocol, prevent filesystem assumptions, prefer the smallest sufficient request, identify tagged patch/write formats, and prohibit shell-command requests.
- GitHub is the issue tracker. The `ready-for-agent` label denotes an issue whose acceptance criteria and blockers are sufficient for an autonomous coding loop such as `afk-ralph-review.sh`.
