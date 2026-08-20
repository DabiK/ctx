/**
 * `ctx read` application use case — the clipboard round trip.
 *
 * Reads the current clipboard content, parses the `@ctx` request it contains
 * (this build: `batch`, `file`, `files`, `tree`, `glob`, `inspect`, `search`,
 * `status`, `changed`, `diff`, `log`, and `show`), executes the operations,
 * and copies one stable protocol response back. `@ctx batch` requests emit a
 * batch envelope with total byte/token metadata and the configured limits.
 * Requests containing only plain read ops keep the legacy single read
 * response; any other request produces a combined response with one section
 * per operation. Malformed or unsupported requests produce a structured
 * refusal response instead of touching the filesystem or running any Git
 * command. Responses that would exceed the configured total budget fail
 * closed: a recovery response identifying the most expensive sections is
 * copied instead of the oversized content.
 */

import { CONFIG_FILE_NAME, PRODUCT_NAME, RESPONSE_MARKER } from "../branding.js";
import { clampBatchBytes, clampFileBytes, parseProjectConfig } from "../config.js";
import {
  isProposalRequest,
  isReadOp,
  parseRequestText,
  SUPPORTED_OPS,
  type ParsedOkRequest,
  type ReadOp,
} from "../protocol.js";
import { createCollector } from "./collect.js";
import {
  EXIT_FAILURE,
  EXIT_OK,
  copyOrThrow,
  requireGitRoot,
  utf8ByteLength,
} from "./common.js";
import type {
  ClipboardPort,
  FsPort,
  GitPort,
  SearchPort,
  TerminalPort,
} from "./ports.js";
import {
  buildBatchResponse,
  buildCombinedResponse,
  buildReadResponse,
  buildRecoveryResponse,
  buildRefusalResponse,
  type ReadItem,
  type ResponsePart,
} from "./response.js";
import { WriteUseCase } from "./write.js";

export interface RequestOptions {
  allowSensitive: boolean;
}

/** Budget and envelope context of the request, resolved once from the config. */
interface RequestBudget {
  /** Clamped total-response budget (max_batch_bytes). */
  maxBatchBytes: number;
  /** Clamped per-file budget (max_file_bytes), shown in the batch envelope. */
  perFileBytes: number;
  /** True when the request used the `@ctx batch` container. */
  usedBatch: boolean;
}

/** The result of executing a parsed request: the copied response and report. */
export interface ExecutedRequest {
  /** Process exit-code intent (`EXIT_OK` / `EXIT_FAILURE`). */
  code: number;
  /** The response text that was copied to the clipboard. */
  response: string;
  /** Info lines the caller should surface (terminal or TUI event log). */
  infoLines: string[];
  /** Error lines the caller should surface (terminal or TUI event log). */
  errorLines: string[];
}

export class RequestUseCase {
  private readonly collector: ReturnType<typeof createCollector>;
  private readonly writes: WriteUseCase;

  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
    search: SearchPort,
  ) {
    this.collector = createCollector(clipboard, terminal, git, fs, search);
    this.writes = new WriteUseCase(clipboard, terminal, git, fs, search);
  }

  async read(opts: RequestOptions): Promise<number> {
    // Fail early outside a Git repository (requireGitRoot reports the error).
    if ((await requireGitRoot(this.git, this.fs, this.terminal)) === null) {
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

    // A tagged write proposal (patch, write, or sequence) is validated and
    // preflighted here without changing anything; applying happens through the
    // explicit `ctx apply` command while the proposal stays in the clipboard.
    if (isProposalRequest(parsed)) {
      return this.writes.preview(parsed, opts.allowSensitive);
    }

    const outcome = await this.execute(parsed, opts);
    if (outcome === null) {
      return EXIT_FAILURE;
    }
    for (const line of outcome.errorLines) {
      this.terminal.error(line);
    }
    for (const line of outcome.infoLines) {
      this.terminal.info(line);
    }
    return outcome.code;
  }

  /**
   * Execute a parsed read request: resolve the project configuration and
   * budgets, build the stable response (legacy single-read response for plain
   * file/files requests, batch or combined envelope otherwise), apply the
   * total-output budget fail closed, and copy it. Returns the copied response
   * plus the report lines the caller surfaces on its channel — `null` on an
   * infrastructure failure (already reported to the terminal).
   */
  async execute(
    parsed: ParsedOkRequest,
    opts: RequestOptions,
  ): Promise<ExecutedRequest | null> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return null;
    }
    const config = parseProjectConfig(this.fs.readText(this.fs.join(root, CONFIG_FILE_NAME)));
    const budget: RequestBudget = {
      maxBatchBytes: clampBatchBytes(config.maxBatchBytes),
      perFileBytes: clampFileBytes(config.maxFileBytes),
      usedBatch: parsed.batch,
    };

    // Plain read-only requests (no batch container) keep the legacy single
    // read response (byte-identical to `ctx files --copy`).
    if (!parsed.batch && parsed.ops.every((op) => op.kind === "file" || op.kind === "files")) {
      const specs = parsed.ops.flatMap((op) => op.specs);
      return this.executeLegacyRead(specs, budget, opts.allowSensitive);
    }

    return this.executeCombined(parsed.ops.filter(isReadOp), opts, budget);
  }

  /** Execute the legacy single-read response for plain file/files requests. */
  private async executeLegacyRead(
    specs: string[],
    budget: RequestBudget,
    allowSensitive: boolean,
  ): Promise<ExecutedRequest | null> {
    const collected = await this.collector.reader.collectSpecs(specs, allowSensitive);
    if (collected === null) {
      return null;
    }
    const { items, maxBatchBytes } = collected;
    const response = buildReadResponse(items);
    const totalBytes = utf8ByteLength(response);
    const readCount = items.filter((i): i is ReadItem => i.kind === "read").length;
    const omittedCount = items.length - readCount;
    const infoLines: string[] = [];
    const errorLines: string[] = [];

    if (totalBytes > maxBatchBytes) {
      const recovery = buildRecoveryResponse(
        items
          .filter((i): i is ReadItem => i.kind === "read")
          .map((i) => ({ title: i.relPath, bytes: i.byteCount })),
        totalBytes,
        maxBatchBytes,
      );
      await copyOrThrow(recovery, this.clipboard, this.terminal);
      errorLines.push(
        `${PRODUCT_NAME}: response over the total budget (${totalBytes} bytes > ${maxBatchBytes}) — ` +
          `${RESPONSE_MARKER} recovery response copied to the clipboard.`,
      );
      return { code: EXIT_FAILURE, response: recovery, infoLines, errorLines };
    }

    await copyOrThrow(response, this.clipboard, this.terminal);
    for (const item of items) {
      if (item.kind === "omitted") {
        errorLines.push(`${item.relPath}: ${item.reason}`);
      }
    }
    infoLines.push(
      `${PRODUCT_NAME}: processed request — ${readCount} read, ${omittedCount} omitted; ` +
        `${RESPONSE_MARKER} copied to the clipboard.`,
    );
    return {
      code: readCount === 0 ? EXIT_FAILURE : EXIT_OK,
      response,
      infoLines,
      errorLines,
    };
  }

  /** Execute a mixed or batch request into one response copied to the clipboard. */
  private async executeCombined(
    ops: ReadOp[],
    opts: RequestOptions,
    budget: RequestBudget,
  ): Promise<ExecutedRequest | null> {
    const parts: ResponsePart[] = [];
    const failures: string[] = [];
    let produced = false;

    for (const op of ops) {
      const exec = await this.collector.collect(op, opts.allowSensitive);
      if (exec === null) {
        // Infrastructure failure (already reported to the terminal).
        return null;
      }
      parts.push(exec.part);
      if (exec.produced) {
        produced = true;
      } else {
        failures.push(exec.part.title);
      }
    }

    // Total-output budget: the copied response must fit; when it would not,
    // a recovery response identifying the costliest sections is copied
    // instead (fail closed, never silently truncated).
    const response = budget.usedBatch
      ? buildBatchResponse(parts, budget.maxBatchBytes, budget.perFileBytes)
      : buildCombinedResponse(parts);
    const totalBytes = utf8ByteLength(response);
    const infoLines: string[] = [];
    const errorLines: string[] = [];
    if (totalBytes > budget.maxBatchBytes) {
      const recovery = buildRecoveryResponse(
        parts.map((p) => ({ title: p.title, bytes: p.bytes })),
        totalBytes,
        budget.maxBatchBytes,
      );
      await copyOrThrow(recovery, this.clipboard, this.terminal);
      errorLines.push(
        `${PRODUCT_NAME}: response over the total budget (${totalBytes} bytes > ${budget.maxBatchBytes}) — ` +
          `recovery response copied to the clipboard.`,
      );
      return { code: EXIT_FAILURE, response: recovery, infoLines, errorLines };
    }
    await copyOrThrow(response, this.clipboard, this.terminal);

    for (const title of failures) {
      errorLines.push(
        `${PRODUCT_NAME}: "${title}" produced no content — see the copied response for details.`,
      );
    }
    infoLines.push(
      `${PRODUCT_NAME}: processed request — ${parts.length} op(s) executed; ` +
        `${parts.length - failures.length} produced content; response copied to the clipboard.`,
    );
    return {
      code: produced ? EXIT_OK : EXIT_FAILURE,
      response,
      infoLines,
      errorLines,
    };
  }
}