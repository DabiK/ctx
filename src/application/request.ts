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

import { CONFIG_FILE_NAME, PRODUCT_NAME } from "../branding.js";
import { clampBatchBytes, clampFileBytes, parseProjectConfig } from "../config.js";
import { parseRequestText, SUPPORTED_OPS, isReadOp, type ReadOp } from "../protocol.js";
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
  buildRecoveryResponse,
  buildRefusalResponse,
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

    // A tagged write proposal (patch, write, or sequence) is validated and
    // preflighted here without changing anything; applying happens through the
    // explicit `ctx apply` command while the proposal stays in the clipboard.
    if (
      parsed.sequence ||
      (parsed.ops.length === 1 &&
        (parsed.ops[0]?.kind === "patch" || parsed.ops[0]?.kind === "write"))
    ) {
      return this.writes.preview(parsed, opts.allowSensitive);
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
      return this.collector.reader.files(specs, {
        copy: true,
        allowSensitive: opts.allowSensitive,
        protocol: true,
      });
    }

    return this.executeCombined(parsed.ops.filter(isReadOp), opts, budget);
  }

  /** Execute a mixed or batch request into one response copied to the clipboard. */
  private async executeCombined(
    ops: ReadOp[],
    opts: RequestOptions,
    budget: RequestBudget,
  ): Promise<number> {
    const parts: ResponsePart[] = [];
    const failures: string[] = [];
    let produced = false;

    for (const op of ops) {
      const exec = await this.collector.collect(op, opts.allowSensitive);
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

    // Total-output budget: the copied response must fit; when it would not,
    // a recovery response identifying the costliest sections is copied
    // instead (fail closed, never silently truncated).
    const response = budget.usedBatch
      ? buildBatchResponse(parts, budget.maxBatchBytes, budget.perFileBytes)
      : buildCombinedResponse(parts);
    const totalBytes = utf8ByteLength(response);
    if (totalBytes > budget.maxBatchBytes) {
      const recovery = buildRecoveryResponse(
        parts.map((p) => ({ title: p.title, bytes: p.bytes })),
        totalBytes,
        budget.maxBatchBytes,
      );
      await copyOrThrow(recovery, this.clipboard, this.terminal);
      this.terminal.error(
        `${PRODUCT_NAME}: response over the total budget (${totalBytes} bytes > ${budget.maxBatchBytes}) — ` +
          `recovery response copied to the clipboard.`,
      );
      return EXIT_FAILURE;
    }
    await copyOrThrow(response, this.clipboard, this.terminal);

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