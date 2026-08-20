/**
 * `@ctx` protocol request parsing (pure domain logic).
 *
 * This build supports the read operations `@ctx file <path>[:<start>-<end>]`,
 * `@ctx files <path>[:<range>] <path>...`, the discovery operations
 * `@ctx tree [--depth N]`, `@ctx glob <pattern>`, `@ctx inspect [path]`, and
 * `@ctx search <query>`, the read-only Git context operations
 * `@ctx status`, `@ctx changed [path]`, `@ctx diff [--staged] [path]`,
 * `@ctx log [--limit N] [path]`, and `@ctx show <rev> <path>`, and the
 * controlled-write proposals `@ctx patch` (one multi-file unified diff body),
 * `@ctx write <path>` (a full-file body), and `@ctx sequence` (one write
 * proposal followed by verification reads that run only after the write).
 *
 * `@ctx batch` composes several read operations into one response: the
 * `@ctx` lines that follow it (in declared order) are its members, so a
 * batch is a flattened container, not a nested grammar. A batch must contain
 * at least one operation and cannot contain another `@ctx batch` (malformed
 * nesting is refused up front). Write proposals are never batch members: a
 * proposal request must contain exactly one proposal (or be a `@ctx
 * sequence`, whose first member is the write and whose remaining members are
 * reads).
 *
 * Proposal bodies span multiple lines: after a `@ctx patch` or
 * `@ctx write <path>` line, every following line (until the next `@ctx` line
 * or the end of the text) is the body. A fenced body (``` or ~~~) must close
 * before the next `@ctx` line; trailing content after the closing fence is
 * refused. Everything else is a structured refusal so the LLM receives a
 * safe next request. Non-`@ctx` lines (ordinary chat text) are ignored.
 * Malformed inputs never touch the filesystem or run any Git command.
 */

import { REQUEST_MARKER } from "./branding.js";
import { MAX_DEPTH, MAX_RESULTS } from "./config.js";

/** 1-based inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

/** One parsed read operation of a clipboard request. */
export type ReadOp =
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

/** One controlled-write proposal: a multi-file patch or a full-file write. */
export type ProposalOp =
  | { kind: "patch"; diff: string }
  | { kind: "write"; path: string; content: string };

/** One parsed operation of a clipboard request. */
export type RequestOp =
  | ReadOp
  | ProposalOp
  | { kind: "sequence"; write: ProposalOp; verify: ReadOp[] };

/** Type guard: true when the operation is a plain read operation. */
export function isReadOp(op: RequestOp): op is ReadOp {
  return op.kind !== "patch" && op.kind !== "write" && op.kind !== "sequence";
}

/** Type guard: true when the operation is a write proposal (patch or write). */
export function isProposalOp(op: RequestOp): op is ProposalOp {
  return op.kind === "patch" || op.kind === "write";
}

export type ParsedRequest =
  | {
      ok: true;
      ops: RequestOp[];
      /** True when the request used the `@ctx batch` container. */
      batch: boolean;
      /** True when the request is a `@ctx sequence` proposal. */
      sequence: boolean;
    }
  | { ok: false; reason: string };

/** The ok branch of {@link ParsedRequest}. */
export type ParsedOkRequest = Extract<ParsedRequest, { ok: true }>;

/** A write proposal: a multi-file patch, a full-file write, or a sequence. */
export type Proposal =
  | ProposalOp
  | { kind: "sequence"; write: ProposalOp; verify: ReadOp[] };

/** True when the parsed request is a standalone write proposal (or a sequence). */
export function isProposalRequest(parsed: ParsedOkRequest): boolean {
  return (
    parsed.sequence ||
    (parsed.ops.length === 1 &&
      (parsed.ops[0]?.kind === "patch" || parsed.ops[0]?.kind === "write"))
  );
}

/** The single write proposal of a parsed request, or `null`. */
export function singleProposal(parsed: ParsedOkRequest): Proposal | null {
  const op = parsed.ops[0];
  if (op === undefined) {
    return null;
  }
  if (isProposalOp(op) || op.kind === "sequence") {
    return op;
  }
  return null;
}

/** Short human-readable label of a read operation (e.g. `file src/foo.ts`). */
export function describeReadOp(op: ReadOp): string {
  switch (op.kind) {
    case "file":
      return `file ${op.specs[0] ?? ""}`;
    case "files":
      return `files ${op.specs.join(" ")}`;
    case "tree":
      return "tree";
    case "glob":
      return `glob ${op.pattern}`;
    case "inspect":
      return "inspect";
    case "search":
      return `search ${op.query}`;
    case "status":
      return "status";
    case "changed":
      return "changed";
    case "diff":
      return "diff";
    case "log":
      return "log";
    case "show":
      return `show ${op.rev} ${op.path}`;
  }
}

/**
 * Parse a single TUI command-entry line into a read operation (pure). The
 * watcher command entry accepts the same read operations as the direct CLI
 * commands; write proposals and batches are not command-entry commands.
 */
export function parseCommandOp(
  text: string,
): { ok: true; op: ReadOp } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty command" };
  }
  const tokens = trimmed.split(/\s+/);
  const op = tokens[0] ?? "";
  const args = tokens.slice(1);
  const parsed = parseReadOp(op, args);
  if ("unsupported" in parsed) {
    return { ok: false, reason: `unsupported command \`${op}\`` };
  }
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  return { ok: true, op: parsed.op };
}

/** Supported operations in this build, for refusal responses. */
export const SUPPORTED_OPS =
  "batch (a block of @ctx read operations), file <path>[:<start>-<end>], files <path>..., tree [--depth N], glob <pattern>, inspect [path], search <query>, status, changed [path], diff [--staged] [path], log [--limit N] [path], show <rev> <path>, patch (a unified multi-file diff body), write <path> (a full-file body), and sequence (one write proposal followed by verification reads)";

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

/**
 * True when a write path is syntactically safe: repository-relative (no
 * absolute path, no `..` traversal) and non-empty. Unlike `show` paths,
 * `:`/`%` characters are allowed because the write target is resolved by the
 * filesystem port, not handed to Git path syntax. The full boundary check
 * (existence, symlink resolution, ignore and sensitive rules) happens in the
 * write guard before any change.
 */
export function isSafeWritePath(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
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

/**
 * Split a proposal body into fenced content. A body whose first non-empty
 * line opens a ``` or ~~~ fence must close with a matching fence; the content
 * between the fences is returned verbatim (the language tag on the opening
 * fence is dropped). Content after the closing fence is refused, and an
 * opening fence without a closing one is refused. Unfenced bodies are
 * returned raw with leading/trailing blank lines trimmed.
 */
export function splitFencedBody(
  lines: string[],
  label: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  const firstNonEmpty = lines.findIndex((l) => l.trim() !== "");
  if (firstNonEmpty === -1) {
    return { ok: true, content: "" };
  }
  const opener = (lines[firstNonEmpty] ?? "").trim();
  const fenceChar = opener.startsWith("```") ? "`" : opener.startsWith("~~~") ? "~" : null;
  if (fenceChar === null) {
    return { ok: true, content: trimBlankEdges(lines).join("\n") };
  }
  const closer = new RegExp(`^${fenceChar}{3,}\\s*$`);
  let closerIdx = -1;
  for (let i = firstNonEmpty + 1; i < lines.length; i++) {
    if (closer.test(lines[i] ?? "")) {
      closerIdx = i;
      break;
    }
  }
  if (closerIdx === -1) {
    return {
      ok: false,
      reason: `unterminated fenced block in the ${label} — the body must close with a matching fence`,
    };
  }
  for (let i = closerIdx + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() !== "") {
      return {
        ok: false,
        reason: `unexpected content after the closing fence of the ${label}`,
      };
    }
  }
  return { ok: true, content: lines.slice(firstNonEmpty + 1, closerIdx).join("\n") };
}

/** One file a unified diff touches, with its change kind. */
export interface DiffTarget {
  /** Repository-relative target path (a/ and b/ prefixes stripped). */
  relPath: string;
  /** Change kind: "new file", "deleted", "renamed", or "modified". */
  kind: string;
}

/**
 * Extract the files a unified diff touches (pure). Targets come from the
 * `---`/`+++` file headers and `rename to` lines, with the conventional `a/`
 * and `b/` prefixes stripped so boundary validation matches what `git apply`
 * would write. Duplicate targets (e.g. a rename with `+++`) are merged.
 */
export function extractDiffTargets(diff: string): DiffTarget[] {
  const targets: DiffTarget[] = [];
  let currentKind = "modified";
  let currentOldPath: string | null = null;

  const push = (relPath: string, kind: string): void => {
    if (
      relPath !== "" &&
      relPath !== "/dev/null" &&
      !targets.some((t) => t.relPath === relPath)
    ) {
      targets.push({ relPath, kind });
    }
  };

  for (const raw of diff.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("diff --git ")) {
      currentKind = "modified";
      currentOldPath = null;
    } else if (line.startsWith("new file mode ")) {
      currentKind = "new file";
    } else if (line.startsWith("deleted file mode ")) {
      currentKind = "deleted";
    } else if (line.startsWith("rename from ")) {
      currentKind = "renamed";
      currentOldPath = stripDiffPrefix(line.slice(12).trim());
    } else if (line.startsWith("rename to ")) {
      push(stripDiffPrefix(line.slice(10).trim()), "renamed");
    } else if (line.startsWith("--- ")) {
      currentOldPath = stripDiffPrefix(line.slice(4).trim());
    } else if (line.startsWith("+++ ")) {
      const path = stripDiffPrefix(line.slice(4).trim());
      if (path === "/dev/null") {
        // Deletion: the target is the old path; the git default kind applies
        // unless the header said `deleted file mode`.
        if (currentOldPath !== null && currentOldPath !== "/dev/null") {
          push(currentOldPath, currentKind === "modified" ? "deleted" : currentKind);
        }
      } else {
        push(path, currentKind);
      }
    }
  }
  return targets;
}

/** Strip the git `a/`/`b/` prefix a `---`/`+++` path may carry. */
function stripDiffPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
}

/** Trim leading and trailing blank lines (used for unfenced bodies). */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") {
    start++;
  }
  while (end > start && (lines[end - 1] ?? "").trim() === "") {
    end--;
  }
  return lines.slice(start, end);
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
 * Non-`@ctx` lines are ordinary chat text and are ignored, except as the body
 * of a `patch` or `write` proposal that directly precedes them; an `@ctx`
 * line for an unsupported operation refuses the whole request.
 */
export function parseRequestText(text: string): ParsedRequest {
  const ops: RequestOp[] = [];
  let sawRequest = false;
  let inBatch = false;
  let sawBatch = false;
  let batchMemberCount = 0;
  let inSequence = false;
  let sawSequence = false;
  let sequenceMemberCount = 0;
  let seqWrite: ProposalOp | null = null;
  let seqVerify: ReadOp[] = [];
  // Collecting state of a multi-line proposal body.
  let collecting: "patch" | "write" | null = null;
  let bodyLines: string[] = [];
  let writePath: string | null = null;
  // True while collecting the inside of an opened fence (``` or ~~~); @ctx
  // lines inside a fence are body content, not request lines.
  let inFence = false;

  const lines = text.split(/\r?\n/);

  const finalizeBody = (): ParsedRequest | null => {
    if (collecting === null) {
      return null;
    }
    const kind = collecting;
    collecting = null;
    const label = kind === "patch" ? "patch" : "write";
    const split = splitFencedBody(bodyLines, label);
    const hadBodyContent = bodyLines.some((l) => l.trim() !== "");
    bodyLines = [];
    if (!split.ok) {
      return { ok: false, reason: split.reason };
    }
    if (kind === "patch") {
      if (!hadBodyContent) {
        return { ok: false, reason: `empty ${REQUEST_MARKER} patch — the unified diff body is missing` };
      }
      const diff = split.content.endsWith("\n") ? split.content : split.content + "\n";
      const op: ProposalOp = { kind: "patch", diff };
      if (inSequence) {
        if (seqWrite === null) {
          seqWrite = op;
        } else {
          return { ok: false, reason: "a sequence accepts exactly one write proposal (its first member)" };
        }
      } else {
        ops.push(op);
      }
    } else {
      const path = writePath ?? "";
      if (!hadBodyContent) {
        return { ok: false, reason: `empty ${REQUEST_MARKER} write — the full-file body is missing` };
      }
      const op: ProposalOp = { kind: "write", path, content: split.content };
      if (inSequence) {
        if (seqWrite === null) {
          seqWrite = op;
        } else {
          return { ok: false, reason: "a sequence accepts exactly one write proposal (its first member)" };
        }
      } else {
        ops.push(op);
      }
    }
    return null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (collecting !== null) {
      // Inside a proposal body. A request line ends the body (unless we are
      // inside an opened fence, where @ctx-looking lines are content).
      if (!inFence && trimmed.startsWith(REQUEST_MARKER)) {
        const finalized = finalizeBody();
        if (finalized !== null) {
          return finalized;
        }
      } else {
        if (inFence && /^(`{3,}|~{3,})\s*$/.test(trimmed)) {
          inFence = false;
        } else if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
          inFence = true;
        }
        bodyLines.push(rawLine);
        continue;
      }
    } else if (!trimmed.startsWith(REQUEST_MARKER)) {
      // Ordinary chat text outside any proposal body.
      continue;
    }
    sawRequest = true;

    // An @ctx line ends any proposal body collected so far.
    const finalized = finalizeBody();
    if (finalized !== null) {
      return finalized;
    }

    const rest = trimmed.slice(REQUEST_MARKER.length).trim();
    if (rest === "") {
      return { ok: false, reason: `empty ${REQUEST_MARKER} request` };
    }
    const tokens = rest.split(/\s+/);
    const op = tokens[0] ?? "";
    const args = tokens.slice(1);
    if (op === "batch") {
      if (inSequence) {
        return {
          ok: false,
          reason:
            `malformed nesting — \`${REQUEST_MARKER} batch\` cannot appear inside a \`${REQUEST_MARKER} sequence\``,
        };
      }
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
    if (op === "sequence") {
      if (inBatch) {
        return {
          ok: false,
          reason:
            `malformed nesting — \`${REQUEST_MARKER} sequence\` cannot appear inside a \`${REQUEST_MARKER} batch\``,
        };
      }
      if (inSequence) {
        return {
          ok: false,
          reason:
            `malformed nesting — \`${REQUEST_MARKER} sequence\` cannot appear inside another sequence`,
        };
      }
      if (args.length !== 0) {
        return {
          ok: false,
          reason: `\`${REQUEST_MARKER} sequence\` accepts no arguments (got: ${args.join(" ")})`,
        };
      }
      inSequence = true;
      sawSequence = true;
      continue;
    }
    if (op === "patch" || op === "write") {
      if (inBatch) {
        return {
          ok: false,
          reason:
            `\`${REQUEST_MARKER} ${op}\` is a write proposal and cannot be a \`${REQUEST_MARKER} batch\` member — ` +
            `use a standalone proposal or a \`${REQUEST_MARKER} sequence\``,
        };
      }
      if (op === "write") {
        if (args.length !== 1) {
          return {
            ok: false,
            reason: `\`${REQUEST_MARKER} write\` requires exactly one repository-relative path (got ${args.length})`,
          };
        }
        const path = args[0] ?? "";
        if (!isSafeWritePath(path)) {
          return {
            ok: false,
            reason:
              `unsafe write path \`${path}\` — write paths must be repository-relative ` +
              `and free of traversal`,
          };
        }
        writePath = path;
      } else if (args.length !== 0) {
        return {
          ok: false,
          reason: `\`${REQUEST_MARKER} patch\` accepts no arguments (got: ${args.join(" ")})`,
        };
      }
      collecting = op;
      if (inSequence) {
        sequenceMemberCount++;
      }
      continue;
    }
    // A read operation. Inside a sequence it is a verification read; the
    // first member of a sequence must be the write proposal.
    if (inSequence && sequenceMemberCount === 0) {
      return {
        ok: false,
        reason:
          `a \`${REQUEST_MARKER} sequence\` must start with one \`${REQUEST_MARKER} patch\` or ` +
          `\`${REQUEST_MARKER} write\` write proposal`,
      };
    }
    const readOp = parseReadOp(op, args);
    if ("unsupported" in readOp) {
      return { ok: false, reason: `unsupported operation \`${op}\`` };
    }
    if (!readOp.ok) {
      return { ok: false, reason: readOp.reason };
    }
    if (inSequence) {
      sequenceMemberCount++;
      seqVerify.push(readOp.op);
    } else if (inBatch) {
      batchMemberCount++;
      ops.push(readOp.op);
    } else {
      ops.push(readOp.op);
    }
    continue;
  }

  // End of text: finalize a trailing proposal body.
  const finalized = finalizeBody();
  if (finalized !== null) {
    return finalized;
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
  if (sawSequence) {
    if (seqWrite === null) {
      return {
        ok: false,
        reason:
          `empty ${REQUEST_MARKER} sequence — add one \`${REQUEST_MARKER} patch\` or ` +
          `\`${REQUEST_MARKER} write\` write proposal, then verification reads`,
      };
    }
    if (seqVerify.length === 0) {
      return {
        ok: false,
        reason:
          `\`${REQUEST_MARKER} sequence\` needs at least one verification read after the write proposal`,
      };
    }
    ops.push({ kind: "sequence", write: seqWrite, verify: seqVerify });
  }
  if (ops.length === 0) {
    return { ok: false, reason: "request contained no supported operations" };
  }

  // A write proposal must be the whole request (standalone or the single
  // sequence op). Mixing a proposal with unrelated operations is refused.
  const proposalIndex = ops.findIndex(
    (o) => o.kind === "patch" || o.kind === "write" || o.kind === "sequence",
  );
  if (proposalIndex !== -1 && ops.length !== 1) {
    return {
      ok: false,
      reason:
        `a write proposal must be the only operation in the request ` +
        `(or the first member of a \`${REQUEST_MARKER} sequence\`)`,
    };
  }

  return { ok: true, ops, batch: sawBatch, sequence: sawSequence };
}

/** Parse one read operation from its name and arguments, or an error reason. */
type ReadOpParse =
  | { ok: true; op: ReadOp }
  | { ok: false; reason: string }
  | { unsupported: true };

function parseReadOp(op: string, args: string[]): ReadOpParse {
  if (op === "file") {
    if (args.length !== 1) {
      return {
        ok: false,
        reason: `\`${REQUEST_MARKER} file\` accepts exactly one path (got ${args.length})`,
      };
    }
    return { ok: true, op: { kind: "file", specs: [args[0] ?? ""] } };
  }
  if (op === "files") {
    if (args.length === 0) {
      return { ok: false, reason: `\`${REQUEST_MARKER} files\` requires at least one path` };
    }
    return { ok: true, op: { kind: "files", specs: args } };
  }
  if (op === "tree") {
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
    return { ok: true, op: { kind: "tree", depth } };
  }
  if (op === "glob") {
    if (args.length !== 1) {
      return {
        ok: false,
        reason: `\`${REQUEST_MARKER} glob\` requires exactly one pattern (got ${args.length})`,
      };
    }
    return { ok: true, op: { kind: "glob", pattern: args[0] ?? "" } };
  }
  if (op === "inspect") {
    if (args.length > 1) {
      return {
        ok: false,
        reason: `\`${REQUEST_MARKER} inspect\` accepts at most one optional path (got ${args.length})`,
      };
    }
    return { ok: true, op: { kind: "inspect", path: args[0] ?? null } };
  }
  if (op === "search") {
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
    return { ok: true, op: { kind: "search", query } };
  }
  if (op === "status") {
    if (args.length !== 0) {
      return {
        ok: false,
        reason: `\`${REQUEST_MARKER} status\` accepts no arguments (got: ${args.join(" ")})`,
      };
    }
    return { ok: true, op: { kind: "status" } };
  }
  if (op === "changed") {
    if (args.length > 1) {
      return {
        ok: false,
        reason: `\`${REQUEST_MARKER} changed\` accepts at most one optional path (got ${args.length})`,
      };
    }
    return { ok: true, op: { kind: "changed", path: args[0] ?? null } };
  }
  if (op === "diff") {
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
    return { ok: true, op: { kind: "diff", staged, path } };
  }
  if (op === "log") {
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
    return { ok: true, op: { kind: "log", limit, path } };
  }
  if (op === "show") {
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
    return { ok: true, op: { kind: "show", rev, path } };
  }
  return { unsupported: true };
}