/**
 * `@ctx` protocol request parsing (pure domain logic).
 *
 * This build supports the read operations `@ctx file <path>[:<start>-<end>]`
 * and `@ctx files <path>[:<range>] <path>...`. Everything else is a structured
 * refusal so the LLM receives a safe next request. Non-`@ctx` lines (ordinary
 * chat text) are ignored. Malformed inputs never touch the filesystem.
 */

import { REQUEST_MARKER } from "./branding.js";

/** 1-based inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

/** One parsed file read operation (`file` = exactly one spec). */
export interface FileOp {
  kind: "file" | "files";
  specs: string[];
}

export type ParsedRequest =
  | { ok: true; ops: FileOp[] }
  | { ok: false; reason: string };

/** Supported read operations in this build, for refusal responses. */
export const SUPPORTED_READ_OPS = "file <path>[:<start>-<end>] and files <path>...";

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
 * Parse a full clipboard request into the read operations it contains.
 * Non-`@ctx` lines are ignored; an `@ctx` line for an unsupported operation
 * refuses the whole request.
 */
export function parseRequestText(text: string): ParsedRequest {
  const ops: FileOp[] = [];
  let sawRequest = false;

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
    if (op === "file") {
      if (args.length !== 1) {
        return {
          ok: false,
          reason: `\`${REQUEST_MARKER} file\` accepts exactly one path (got ${args.length})`,
        };
      }
      ops.push({ kind: "file", specs: [args[0] ?? ""] });
    } else if (op === "files") {
      if (args.length === 0) {
        return { ok: false, reason: `\`${REQUEST_MARKER} files\` requires at least one path` };
      }
      ops.push({ kind: "files", specs: args });
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
  if (ops.length === 0) {
    return { ok: false, reason: "request contained no supported operations" };
  }
  return { ok: true, ops };
}