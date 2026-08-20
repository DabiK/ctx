## Parent

Implements part of #1.

## What to build

Deliver the first safe clipboard round trip. A developer can request one or many repository files with `@ctx file` and `@ctx files`, including bounded line ranges, or invoke the equivalent direct commands. ctx returns a stable, LLM-ready response with line numbers and copies it only when requested directly or through the clipboard protocol.

This slice establishes the repository permission boundary: Git root detection, `.ctxignore`, configured allowed roots, resolved-link validation, sensitive path/content omission, and clear structured refusal/recovery responses. Direct terminal output remains concise; copied output is the stable protocol response.

## Acceptance criteria

- [ ] A valid clipboard request for a file or file list produces an LLM-ready response containing requested paths, selected lines, and configured line numbering.
- [ ] Direct reads print to the terminal by default and copy only with `--copy`; protocol-driven reads copy the response.
- [ ] Traversal, absolute paths, paths outside configured roots, and links escaping an allowed root are refused without reading or copying content.
- [ ] `.ctxignore` exclusions and obvious sensitive content/path checks omit only unsafe items and explain the omission; sensitive disclosure requires an explicit override.
- [ ] Parser/security/integration tests exercise requests against temporary Git repositories and fake clipboard ports.

## Blocked by

- #2 Bootstrap CLI, init, prompt and doctor.

