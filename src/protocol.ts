/**
 * `@ctx` protocol request parsing (pure domain logic).
 *
 * This build supports the read operations `@ctx file <path>[:<start>-<end>]`,
 * `@ctx files <path>[:<range>] <path>...`, the discovery operations
 * `@ctx tree [--depth N]`, `@ctx glob <pattern>`, `@ctx inspect [path]`, and
 * `@ctx search <query>`, and the read-only Git context operations
 * `@ctx status`, `@ctx changed [path]`, `@ctx diff [--staged] [path]`,
 * `@ctx log [--limit N] [path]`, and `@ctx show <rev> <path>`.
 *
 * `@ctx batch` composes several operations into one response: the `@ctx`
 * lines that follow it (in declared order) are its members, so a batch is a
 * flattened container, not a nested grammar. A batch must contain at least
 * one operation and cannot contain another `@ctx batch` (malformed nesting is
 * refused up front). Everything else is a structured refusal so the LLM
 * receives a safe next request. Non-`@ctx` lines (ordinary chat text) are
 * ignored. Malformed inputs never touch the filesystem or run any Git
 * command.
 */

import { REQUEST_MARKER } from "./branding.js";
import { MAX_DEPTH, MAX_RESULTS } from "./config.js";

/** 1-based inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

/** One parsed operation of a clipboard request. */
export type RequestOp =
  | { kind: "file"; specs: string[] }
  | { kind: "files"; specs: string[] }
  | { kind: "tree"; depth: number | null }
  | { kind: "glob"; pattern: string }
  | { kind: "inspect"; path: string | null }
  | { kind: "search"; query: string }
  | { kind: "status" }
  | { kind: "changed"; path: string | null }
  | { kind: "diff"; staged: boolean; path: string | null }
  | { kind: "log"; limit: number | null; path: string | null }
  | { kind: "show"; rev: string; path: string };

export type ParsedRequest =
  | { ok: true; ops: RequestOp[]; /** True when the request used the `@ctx batch` container. */ batch: boolean }
  | { ok: false; reason: string };

/** Supported operations in this build, for refusal responses. */
export const SUPPORTED_OPS =
  "batch (a block of @ctx operations), file <path>[:<start>-<end>], files <path>..., tree [--depth N], glob <pattern>, inspect [path], search <query>, status, changed [path], diff [--staged] [path], log [--limit N] [path], and show <rev> <path>";

/**
 * True when `rev` is a safe, unambiguous Git revision for `show`: HEAD (with
 * optional `~N`/`^N` ancestry), a full or abbreviated hex commit hash, or a
 * branch/tag name made of dot-separated alphanumeric segments. Anything that
 * could smuggle command fragments, options, or revision ranges (spaces,
 * `..`, shell metacharacters, leading dashes) is refused.
 */
export function isSafeRevision(rev: string): boolean {
  if (rev.length === 0 || rev.length > 100) {
    return false;
  }
  if (rev === "HEAD") {
    return true;
  }
  if (/^HEAD(~[0-9]+|\^[0-9]*)$/.test(rev)) {
    return true;
  }
  if (/^[0-9a-fA-F]{7,40}$/.test(rev)) {
    return true;
  }
  if (
    /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/.test(rev) &&
    !/[/.][/.]/.test(rev)
  ) {
    return true;
  }
  return false;
}

/**
 * True when a `show` path is syntactically safe: repository-relative (no
 * absolute path, no `..` traversal) and free of the `:`/`%` characters that
 * Git path syntax treats specially in `<rev>:<path>` form. `show` reads from
 * the object store, so existence is validated by Git itself; this check
 * refuses only forms that could be misparsed or escape the repository.
 */
export function isSafeShowPath(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return false;
  }
  if (trimmed.includes(":") || trimmed.includes("%")) {
    return false;
  }
  const segments = trimmed.split(/[\\/]+/).filter((s) => s.length > 0);
  return (
    segments.length > 0 &&
    !segments.some((s) => s === ".." || s === ".") &&
    !trimmed.endsWith("/") &&
    !trimmed.endsWith("\\")
  );
}

export type PathSpec =
  | { ok: true; path: string; range: LineRange | null }
  | { ok: false; error: string };

/**
 * Parse a `path[:start-end]` specification. Supported range forms:
 * `path`, `path:N`, `path:N-M`, `path:N-` (to end), `path:-M` (from line 1).
 */
export function parsePathSpec(spec: string): PathSpec {
  const trimmed = spec.trim();
  if (trimmed === "") {
    return { ok: false, error: "empty path" };
  }
  const invalid = `invalid line range in \`${trimmed}\` — expected <path>:<start>-<end>`;

  // The range suffix is bound to the last colon whose tail parses as a
  // range; `notes:meeting.md` keeps its colon and stays a plain path.
  const colonIndex = trimmed.lastIndexOf(":");
  const rangePart = colonIndex >= 0 ? trimmed.slice(colonIndex + 1) : "";
  if (rangePart === "" || /[^0-9-]/.test(rangePart)) {
    return { ok: true, path: trimmed, range: null };
  }

  const path = trimmed.slice(0, colonIndex);
  if (path === "") {
    return { ok: false, error: invalid };
  }

  // `path:-M` (start omitted): lines 1..M.
  const fromStart = /^-(\d+)$/.exec(rangePart);
  if (fromStart !== null) {
    const end = Number(fromStart[1]);
    if (!Number.isInteger(end) || end < 1) {
      return { ok: false, error: invalid };
    }
    return { ok: true, path, range: { start: 1, end } };
  }

  // `path:N-M` (full range).
  const full = /^(\d+)-(\d+)$/.exec(rangePart);
  if (full !== null) {
    const start = Number(full[1]);
    const end = Number(full[2]);
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) {
      return { ok: false, error: invalid };
    }
    return { ok: true, path, range: { start, end } };
  }

  // `path:N-` (from N to the end of the file).
  const openEnd = /^(\d+)-$/.exec(rangePart);
  if (openEnd !== null) {
    const start = Number(openEnd[1]);
    if (!Number.isInteger(start) || start < 1) {
      return { ok: false, error: invalid };
    }
    return { ok: true, path, range: { start, end: Number.MAX_SAFE_INTEGER } };
  }

  // `path:N` (single line).
  const single = /^(\d+)$/.exec(rangePart);
  if (single !== null) {
    const start = Number(single[1]);
    if (!Number.isInteger(start) || start < 1) {
      return { ok: false, error: invalid };
    }
    return { ok: true, path, range: { start, end: start } };
  }

  return { ok: false, error: invalid };
}

/**
 * Parse a full clipboard request into the operations it contains.
 * Non-`@ctx` lines are ignored; an `@ctx` line for an unsupported operation
 * refuses the whole request.
 */
export function parseRequestText(text: string): ParsedRequest {
  const ops: RequestOp[] = [];
  let sawRequest = false;
  let inBatch = false;
  let sawBatch = false;
  let batchMemberCount = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    if (!line.startsWith(REQUEST_MARKER)) {
      continue;
    }
    sawRequest = true;
    const rest = line.slice(REQUEST_MARKER.length).trim();
    if (rest === "") {
      return { ok: false, reason: `empty ${REQUEST_MARKER} request` };
    }
    const tokens = rest.split(/\s+/);
    const op = tokens[0] ?? "";
    const args = tokens.slice(1);
    if (op === "batch") {
      if (args.length !== 0) {
        return {
          ok: false,
          reason: `\`${REQUEST_MARKER} batch\` accepts no arguments (got: ${args.join(" ")})`,
        };
      }
      if (inBatch) {
        return {
          ok: false,
          reason:
            `malformed nesting — \`${REQUEST_MARKER} batch\` cannot appear inside another batch`,
        };
      }
      inBatch = true;
      sawBatch = true;
      continue;
    }
    if (op === "file") {
      if (args.length !== 1) {
        return {
          ok: false,
          reason: `\`${REQUEST_MARKER} file\` accepts exactly one path (got ${args.length})`,
        };
      }
      ops.push({ kind: "file", specs: [args[0] ?? ""] });
      if (inBatch) batchMemberCount++;
    } else if (op === "files") {
      if (args.length === 0) {
        return { ok: false, reason: `\`${REQUEST_MARKER} files\` requires at least one path` };
      }
      ops.push({ kind: "files", specs: args });
      if (inBatch) batchMemberCount++;
    } else if (op === "tree") {
      let depth: number | null = null;
      if (args.length === 2 && (args[0] ?? "") === "--depth") {
        const n = Number(args[1]);
        if (!Number.isInteger(n) || n < 1 || n > MAX_DEPTH) {
          return {
            ok: false,
            reason: `\`${REQUEST_MARKER} tree --depth\` requires an integer between 1 and ${MAX_DEPTH}`,
          };
        }
        depth = n;
      } else if (args.length !== 0) {
        return {
          ok: false,
          reason: `\`${REQUEST_MARKER} tree\` accepts only an optional --depth N (got: ${args.join(" ")})`,
        };
      }
      ops.push({ kind: "tree", depth });
      if (inBatch) batchMemberCount++;
    } else if (op === "glob") {
      if (args.length !== 1) {
        return {
          ok: false,
          reason: `\`${REQUEST_MARKER} glob\` requires exactly one pattern (got ${args.length})`,
        };
      }
      ops.push({ kind: "glob", pattern: args[0] ?? "" });
      if (inBatch) batchMemberCount++;
    } else if (op === "inspect") {
      if (args.length > 1) {
        return {
          ok: false,
          reason: `\`${REQUEST_MARKER} inspect\` accepts at most one optional path (got ${args.length})`,
        };
      }
      ops.push({ kind: "inspect", path: args[0] ?? null });
      if (inBatch) batchMemberCount++;
    } else if (op === "search") {
      if (args.length === 0) {
        return { ok: false, reason: `\`${REQUEST_MARKER} search\` requires at least one query term` };
      }
      let query = args.join(" ");
      // `@ctx search "foo bar"` — strip the wrapper quotes the LLM may add.
      if (query.length >= 2 && query.startsWith('"') && query.endsWith('"')) {
        query = query.slice(1, -1);
      }
      if (query === "") {
        return { ok: false, reason: `\`${REQUEST_MARKER} search\` requires a non-empty query` };
      }
      ops.push({ kind: "search", query });
      if (inBatch) batchMemberCount++;
    } else if (op === "status") {
      if (args.length !== 0) {
        return {
          ok: false,
          reason: `\`${REQUEST_MARKER} status\` accepts no arguments (got: ${args.join(" ")})`,
        };
      }
      ops.push({ kind: "status" });
      if (inBatch) batchMemberCount++;
    } else if (op === "changed") {
      if (args.length > 1) {
        return {
          ok: false,
          reason: `\`${REQUEST_MARKER} changed\` accepts at most one optional path (got ${args.length})`,
        };
      }
      ops.push({ kind: "changed", path: args[0] ?? null });
      if (inBatch) batchMemberCount++;
    } else if (op === "diff") {
      let staged = false;
      let path: string | null = null;
      for (const arg of args) {
        if (arg === "--staged") {
          staged = true;
        } else if (path === null) {
          path = arg;
        } else {
          return {
            ok: false,
            reason: `\`${REQUEST_MARKER} diff\` accepts only [--staged] and one optional path (got: ${args.join(" ")})`,
          };
        }
      }
      ops.push({ kind: "diff", staged, path });
      if (inBatch) batchMemberCount++;
    } else if (op === "log") {
      let limit: number | null = null;
      let path: string | null = null;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? "";
        if (arg === "--limit") {
          const n = Number(args[i + 1]);
          if (!Number.isInteger(n) || n < 1 || n > MAX_RESULTS) {
            return {
              ok: false,
              reason: `\`${REQUEST_MARKER} log --limit\` requires an integer between 1 and ${MAX_RESULTS}`,
            };
          }
          limit = n;
          i++;
        } else if (path === null) {
          path = arg;
        } else {
          return {
            ok: false,
            reason: `\`${REQUEST_MARKER} log\` accepts only [--limit N] and one optional path (got: ${args.join(" ")})`,
          };
        }
      }
      ops.push({ kind: "log", limit, path });
      if (inBatch) batchMemberCount++;
    } else if (op === "show") {
      if (args.length !== 2) {
        return {
          ok: false,
          reason: `\`${REQUEST_MARKER} show\` requires exactly <rev> and <path> (got ${args.length})`,
        };
      }
      const rev = args[0] ?? "";
      const path = args[1] ?? "";
      if (!isSafeRevision(rev)) {
        return {
          ok: false,
          reason:
            `unsafe revision \`${rev}\` — show accepts only HEAD (with ~N/^N), ` +
            `hex commit hashes, or plain branch/tag names`,
        };
      }
      if (!isSafeShowPath(path)) {
        return {
          ok: false,
          reason:
            `unsafe path \`${path}\` — show paths must be repository-relative ` +
            `and free of traversal and \`:\`/\`%\` characters`,
        };
      }
      ops.push({ kind: "show", rev, path });
      if (inBatch) batchMemberCount++;
    } else {
      return {
        ok: false,
        reason: `unsupported operation \`${op}\``,
      };
    }
  }

  if (!sawRequest) {
    return { ok: false, reason: `no ${REQUEST_MARKER} request found in the clipboard content` };
  }
  if (sawBatch && batchMemberCount === 0) {
    return {
      ok: false,
      reason: `empty ${REQUEST_MARKER} batch — add at least one operation after \`${REQUEST_MARKER} batch\``,
    };
  }
  if (ops.length === 0) {
    return { ok: false, reason: "request contained no supported operations" };
  }
  return { ok: true, ops, batch: sawBatch };
}