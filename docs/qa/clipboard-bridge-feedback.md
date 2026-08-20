# Blind chat QA — clipboard bridge

## Goal

Exercise ctx as a web-chat runtime: an OpenCode session has no direct project
tools and sees only the protocol copied by `ctx init` plus `# CTX RESPONSE`
messages returned over the clipboard.

## Fixture

- Isolated Git repository: `/tmp/ctx-qa.DZCHuQ`.
- Small static Focus List app (`index.html`, `app.js`, `styles.css`).
- Moderate task: priorities, inline rename, localStorage migration, completion
  and priority filters, and a summary count.

## Friction found

1. A model may emit several `@ctx write` blocks for a multi-file feature. The
   protocol accepts one proposal only; the prompt must require a single
   multi-file `@ctx patch` in that situation.
2. Global OpenCode MCP tools can leak into a supposedly blind agent. The QA
   harness must deny all tools (`"*": false`), not just file and shell tools.
   We observed and blocked `chrome-devtools_*`, `okoach_*`, and `pencil_*`.
3. Tool failures can cause duplicated ctx requests. The runtime should make
   duplicate requests harmless and the prompt should demand one standalone
   protocol block per response.
4. The watcher/direct-command distinction must be explicit: with `ctx watch`
   active, the chat must not tell the user to run `ctx read`; the watcher has
   already consumed the request and replaced the clipboard with its response.

## Valid run 5

With all tools denied, the agent emitted only `@ctx inspect`. After receiving
the real ctx response it emitted a compact `@ctx batch` requesting exactly
`app.js`, `index.html`, and `styles.css`. This validates the first two turns
of a blind-chat conversation without agent filesystem access.

## Next steps

- Continue the same session through its single multi-file patch and post-write
  verification read.
- Test the same raw responses through `ctx watch` in safe and yolo modes.
- Turn each confirmed friction into a regression test before release.

## Completion attempt

The valid blind agent completed `inspect` and requested the three source files
through a batch. The batch executed successfully. After receiving that real
multi-file CTX response, however, the OpenCode session returned an empty model
turn twice; a fresh continuation given the same response also returned empty.
A minimal fresh-session health check still returned `QA_OK`, which isolates the
failure to the multi-file context handoff rather than the model/provider.

The moderate feature therefore was not applied. This is a release-blocking QA
friction: ctx needs a reproducible raw-transcript fixture for multi-file
responses and a diagnosis of why this OpenCode configuration stops responding
after that handoff.
