/**
 * `ctx prompt` application use case.
 *
 * Regenerates the protocol prompt on the clipboard (the same content
 * `ctx init` copies, including the root AGENTS.md or its reported absence).
 * Never creates a prompt file in the project. Depends only on application
 * ports — no Node/OS imports.
 */

import type { ClipboardPort, FsPort, GitPort, TerminalPort } from "./ports.js";
import {
  EXIT_FAILURE,
  EXIT_OK,
  buildClipboardPayload,
  copyPayload,
  requireGitRoot,
} from "./common.js";

export interface PromptOptions {
  compact: boolean;
}

export class PromptUseCase {
  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
  ) {}

  async prompt(opts: PromptOptions): Promise<number> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return EXIT_FAILURE;
    }

    const payload = buildClipboardPayload(root, this.fs, opts.compact);
    await copyPayload(payload, this.clipboard, this.terminal);
    return EXIT_OK;
  }
}
