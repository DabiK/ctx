# ctx vocabulary

- **ctx**: the local CLI and terminal UI that executes a narrow, controlled set of repository operations.
- **LLM**: a web chat with no filesystem, shell, API, MCP, browser-control, or direct machine access.
- **human**: the person moving data through the clipboard and granting the permission boundary.
- **request**: an `@ctx` protocol block copied from the LLM and executed locally.
- **response**: a stable `# CTX RESPONSE` block copied back to the LLM.
- **sequence**: an ordered request that can write and then read verification context only after the write succeeds.
- **patch**: a unified Git diff proposed by the LLM.
- **full write**: a complete-content replacement or creation proposed by the LLM through `@ctx write`.
- **watcher**: the foreground interactive TUI that observes clipboard changes and exposes ctx actions.
- **mode**: `safe`, `auto`, or `yolo`, controlling confirmation behavior in the watcher.
- **allowed root**: the Git repository root or an explicitly configured external directory from which ctx may read.
- **sensitive content**: content or a path that must not be copied to an external LLM without an explicit override.

