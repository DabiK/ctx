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
import { parseRequestText, SUPPORTED_OPS, type RequestOp } from "../protocol.js";
import {
  EXIT_FAILURE,
  EXIT_OK,
  copyOrThrow,
  requireGitRoot,
  utf8ByteLength,
} from "./common.js";
import { DiscoveryUseCase, type OpExecution } from "./discovery.js";
import { GitUseCase } from "./git.js";
import type {
  ClipboardPort,
  FsPort,
  GitPort,
  SearchPort,
  TerminalPort,
} from "./ports.js";
import { ReadUseCase } from "./read.js";
import {
  buildBatchResponse,
  buildCombinedResponse,
  buildReadPart,
  buildRecoveryResponse,
  buildRefusalResponse,
  type ResponsePart,
} from "./response.js";
import { SearchUseCase } from "./search.js";

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
  private readonly reader: ReadUseCase;
  private readonly discovery: DiscoveryUseCase;
  private readonly search: SearchUseCase;
  private readonly gitOps: GitUseCase;

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
    this.gitOps = new GitUseCase(clipboard, terminal, git, fs);
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
      return this.reader.files(specs, {
        copy: true,
        allowSensitive: opts.allowSensitive,
        protocol: true,
      });
    }

    return this.executeCombined(parsed.ops, opts, budget);
  }

  /** Execute a mixed or batch request into one response copied to the clipboard. */
  private async executeCombined(
    ops: RequestOp[],
    opts: RequestOptions,
    budget: RequestBudget,
  ): Promise<number> {
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
              maxBatchBytes: collected.maxBatchBytes,
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
        case "status":
          exec = await this.gitOps.collectStatus(opts.allowSensitive);
          break;
        case "changed":
          exec = await this.gitOps.collectChanged(op.path, opts.allowSensitive);
          break;
        case "diff":
          exec = await this.gitOps.collectDiff(op.path, op.staged, opts.allowSensitive);
          break;
        case "log":
          exec = await this.gitOps.collectLog(op.path, opts.allowSensitive, op.limit);
          break;
        case "show":
          exec = await this.gitOps.collectShow(op.rev, op.path, opts.allowSensitive);
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