/**
 * `ctx read` application use case — the clipboard round trip.
 *
 * Reads the current clipboard content, parses the `@ctx` request it contains
 * (this build: `file`, `files`, `tree`, `glob`, `inspect`, and `search`),
 * executes the operations, and copies one stable protocol response back.
 * Requests containing only read ops keep the legacy single read response;
 * any request with discovery ops produces a combined response with one
 * section per operation. Malformed or unsupported requests produce a
 * structured refusal response instead of touching the filesystem.
 */

import { PRODUCT_NAME } from "../branding.js";
import { parseRequestText, SUPPORTED_OPS, type RequestOp } from "../protocol.js";
import {
  EXIT_FAILURE,
  EXIT_OK,
  copyOrThrow,
  requireGitRoot,
} from "./common.js";
import { DiscoveryUseCase, type OpExecution } from "./discovery.js";
import type {
  ClipboardPort,
  FsPort,
  GitPort,
  SearchPort,
  TerminalPort,
} from "./ports.js";
import { ReadUseCase } from "./read.js";
import {
  buildCombinedResponse,
  buildReadPart,
  buildRefusalResponse,
  type ResponsePart,
} from "./response.js";
import { SearchUseCase } from "./search.js";

export interface RequestOptions {
  allowSensitive: boolean;
}

export class RequestUseCase {
  private readonly reader: ReadUseCase;
  private readonly discovery: DiscoveryUseCase;
  private readonly search: SearchUseCase;

  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
    search: SearchPort,
  ) {
    this.reader = new ReadUseCase(clipboard, terminal, git, fs);
    this.discovery = new DiscoveryUseCase(clipboard, terminal, git, fs);
    this.search = new SearchUseCase(clipboard, terminal, git, fs, search);
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
      const response = buildRefusalResponse(parsed.reason, SUPPORTED_OPS);
      await copyOrThrow(response, this.clipboard, this.terminal);
      this.terminal.error(
        `${PRODUCT_NAME}: request refused — ${parsed.reason} (refusal copied to the clipboard).`,
      );
      return EXIT_FAILURE;
    }

    // Read-only requests keep the legacy single read response (byte-identical
    // to `ctx files --copy`).
    if (parsed.ops.every((op) => op.kind === "file" || op.kind === "files")) {
      const specs = parsed.ops.flatMap((op) => op.specs);
      return this.reader.files(specs, {
        copy: true,
        allowSensitive: opts.allowSensitive,
        protocol: true,
      });
    }

    return this.executeCombined(parsed.ops, opts);
  }

  /** Execute a mixed request into one combined response copied to the clipboard. */
  private async executeCombined(ops: RequestOp[], opts: RequestOptions): Promise<number> {
    const parts: ResponsePart[] = [];
    const failures: string[] = [];
    let produced = false;

    for (const op of ops) {
      let exec: OpExecution | null = null;
      switch (op.kind) {
        case "file":
        case "files": {
          const collected = await this.reader.collectSpecs(op.specs, opts.allowSensitive);
          if (collected !== null) {
            const items = collected.items;
            const readCount = items.filter((i) => i.kind === "read").length;
            exec = {
              part: buildReadPart(items, op.kind === "file" ? `file ${op.specs[0] ?? ""}` : `files ${op.specs.join(" ")}`),
              produced: readCount > 0,
            };
          }
          break;
        }
        case "tree":
          exec = await this.discovery.collectTree(op.depth, opts.allowSensitive);
          break;
        case "glob":
          exec = await this.discovery.collectGlob(op.pattern, opts.allowSensitive, null);
          break;
        case "inspect":
          exec = await this.discovery.collectInspect(op.path, opts.allowSensitive, null);
          break;
        case "search":
          exec = await this.search.collectSearch(op.query, opts.allowSensitive, null);
          break;
      }

      if (exec === null) {
        // Infrastructure failure (already reported to the terminal).
        return EXIT_FAILURE;
      }
      parts.push(exec.part);
      if (exec.produced) {
        produced = true;
      } else {
        failures.push(exec.part.title);
      }
    }

    await copyOrThrow(buildCombinedResponse(parts), this.clipboard, this.terminal);

    for (const title of failures) {
      this.terminal.error(
        `${PRODUCT_NAME}: "${title}" produced no content — see the copied response for details.`,
      );
    }
    this.terminal.info(
      `${PRODUCT_NAME}: processed request — ${parts.length} op(s) executed; ` +
        `${parts.length - failures.length} produced content; response copied to the clipboard.`,
    );
    return produced ? EXIT_OK : EXIT_FAILURE;
  }
}