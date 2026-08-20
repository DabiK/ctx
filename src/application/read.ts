/**
 * `ctx file` / `ctx files` application use case.
 *
 * Reads one or many repository-relative files (with optional bounded line
 * ranges) through the repository permission boundary. Direct reads print the
 * selected content to the terminal and copy the stable protocol response only
 * with `--copy`; protocol-driven reads always copy it. Refused and omitted
 * items are always explained and never silently dropped.
 */

import { CONFIG_FILE_NAME, PRODUCT_NAME, RESPONSE_MARKER } from "../branding.js";
import { parseProjectConfig } from "../config.js";
import { parsePathSpec } from "../protocol.js";
import { containsSensitiveContent } from "../sensitive.js";
import { PathGuard } from "./boundary.js";
import {
  EXIT_FAILURE,
  EXIT_OK,
  copyOrThrow,
  requireGitRoot,
  utf8ByteLength,
} from "./common.js";
import type { ClipboardPort, FsPort, GitPort, TerminalPort } from "./ports.js";
import {
  buildReadResponse,
  renderLines,
  type OmittedItem,
  type ReadItem,
  type ReadResultItem,
} from "./response.js";

export interface ReadOptions {
  copy: boolean;
  allowSensitive: boolean;
  /** Protocol-driven reads never print raw content and always copy. */
  protocol: boolean;
}

export class ReadUseCase {
  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
  ) {}

  /** `ctx file <spec>` — exactly one path, optionally with a line range. */
  async file(spec: string, opts: ReadOptions): Promise<number> {
    return this.readSpecs([spec], opts);
  }

  /** `ctx files <spec>...` — several paths in one request. */
  async files(specs: string[], opts: ReadOptions): Promise<number> {
    return this.readSpecs(specs, opts);
  }

  /**
   * Shared execution for direct and protocol-driven reads. Exits non-zero
   * when nothing could be read (all items refused or missing).
   */
  async readSpecs(specs: string[], opts: ReadOptions): Promise<number> {
    const collected = await this.collectSpecs(specs, opts.allowSensitive);
    if (collected === null) {
      return EXIT_FAILURE;
    }
    const { items } = collected;

    if (opts.copy) {
      await copyOrThrow(buildReadResponse(items), this.clipboard, this.terminal);
    }

    this.printTerminal(items, opts);

    const readCount = items.filter((i): i is ReadItem => i.kind === "read").length;
    return readCount === 0 ? EXIT_FAILURE : EXIT_OK;
  }

  /**
   * Execute read specs through the permission boundary without copying or
   * printing. Shared with the request use case so read operations can be
   * combined with discovery operations in one clipboard response.
   */
  async collectSpecs(
    specs: string[],
    allowSensitive: boolean,
  ): Promise<{ items: ReadResultItem[] } | null> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return null;
    }

    const config = parseProjectConfig(this.fs.readText(this.fs.join(root, CONFIG_FILE_NAME)));
    const guard = new PathGuard(root, config, allowSensitive, this.fs);

    const items: ReadResultItem[] = [];
    for (const spec of specs) {
      items.push(this.readOne(spec, guard, allowSensitive, config.lineNumbers));
    }
    return { items };
  }

  /** Read one spec through the guard, producing a read or omitted item. */
  private readOne(
    spec: string,
    guard: PathGuard,
    allowSensitive: boolean,
    lineNumbers: boolean,
  ): ReadResultItem {
    const parsed = parsePathSpec(spec);
    if (!parsed.ok) {
      return { kind: "omitted", relPath: spec, reason: parsed.error };
    }
    const guarded = guard.guard(parsed.path);
    if (!guarded.ok) {
      return { kind: "omitted", relPath: parsed.path, reason: guarded.reason };
    }

    const content = this.fs.readText(guarded.absPath);
    if (content === null) {
      return { kind: "omitted", relPath: parsed.path, reason: "unreadable file" };
    }
    if (!allowSensitive && containsSensitiveContent(content)) {
      return {
        kind: "omitted",
        relPath: parsed.path,
        reason: "contains sensitive content — requires an explicit override to disclose",
      };
    }

    const fileLines = splitLines(content);
    const total = fileLines.length;
    const requested = parsed.range ?? { start: 1, end: total };
    if (requested.start > total) {
      return {
        kind: "omitted",
        relPath: parsed.path,
        reason: `line range starts beyond the end of the file (${total} lines)`,
      };
    }
    const end = Math.min(requested.end, total);
    const clamped = end !== requested.end;
    const lines = fileLines.slice(requested.start - 1, end);
    const text = renderLines(lines, requested.start, lineNumbers);

    return {
      kind: "read",
      relPath: guarded.relPath,
      lines,
      start: requested.start,
      end,
      totalLines: total,
      byteCount: utf8ByteLength(text),
      lineNumbers,
      clamped,
    };
  }

  /** Concise terminal output; the copied response stays the protocol block. */
  private printTerminal(items: ReadResultItem[], opts: ReadOptions): void {
    for (const item of items) {
      if (item.kind === "read") {
        if (!opts.protocol) {
          this.terminal.info(
            `${item.relPath}: read ${item.start}-${item.end} of ${item.totalLines} lines, ` +
              `${item.byteCount} bytes${item.clamped ? " (clamped to file length)" : ""}`,
          );
          this.terminal.info(renderLines(item.lines, item.start, item.lineNumbers));
        }
      } else {
        this.terminal.error(`${item.relPath}: ${item.reason}`);
      }
    }

    const readCount = items.filter((i): i is ReadItem => i.kind === "read").length;
    const omittedCount = items.length - readCount;
    if (opts.protocol) {
      this.terminal.info(
        `${PRODUCT_NAME}: processed request — ${readCount} read, ${omittedCount} omitted; ` +
          `${RESPONSE_MARKER} copied to the clipboard.`,
      );
    } else if (opts.copy) {
      this.terminal.info(
        `Protocol response (${RESPONSE_MARKER}) copied to the clipboard.`,
      );
    }
  }
}

/** Split file content into lines, dropping the empty trailing element. */
function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && (lines[lines.length - 1] ?? "") === "") {
    lines.pop();
  }
  return lines;
}