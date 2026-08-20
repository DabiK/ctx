/**
 * `ctx read` application use case — the clipboard round trip.
 *
 * Reads the current clipboard content, parses the `@ctx` request it contains
 * (this build: `file` / `files`), executes it through the read use case, and
 * copies the stable protocol response back. Malformed or unsupported requests
 * produce a structured refusal response instead of touching the filesystem.
 */

import { PRODUCT_NAME } from "../branding.js";
import { parseRequestText, SUPPORTED_READ_OPS } from "../protocol.js";
import {
  EXIT_FAILURE,
  copyOrThrow,
  requireGitRoot,
} from "./common.js";
import type { ClipboardPort, FsPort, GitPort, TerminalPort } from "./ports.js";
import { ReadUseCase } from "./read.js";
import { buildRefusalResponse } from "./response.js";

export interface RequestOptions {
  allowSensitive: boolean;
}

export class RequestUseCase {
  private readonly reader: ReadUseCase;

  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
  ) {
    this.reader = new ReadUseCase(clipboard, terminal, git, fs);
  }

  async read(opts: RequestOptions): Promise<number> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return EXIT_FAILURE;
    }

    let requestText: string;
    try {
      requestText = await this.clipboard.read();
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : "";
      this.terminal.error(`Failed to read the clipboard${detail}`);
      return EXIT_FAILURE;
    }

    const parsed = parseRequestText(requestText);
    if (!parsed.ok) {
      const response = buildRefusalResponse(parsed.reason, SUPPORTED_READ_OPS);
      await copyOrThrow(response, this.clipboard, this.terminal);
      this.terminal.error(
        `${PRODUCT_NAME}: request refused — ${parsed.reason} (refusal copied to the clipboard).`,
      );
      return EXIT_FAILURE;
    }

    const specs = parsed.ops.flatMap((op) => op.specs);
    return this.reader.files(specs, {
      copy: true,
      allowSensitive: opts.allowSensitive,
      protocol: true,
    });
  }
}