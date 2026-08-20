/**
 * Stable `# CTX RESPONSE` formatting for read and discovery operations
 * (application logic).
 *
 * Copied output is always the protocol response; direct terminal reads print
 * the same sections without the protocol envelope. The formatters here are the
 * single source of the response shape so direct `--copy`, clipboard-driven
 * requests, and combined requests produce byte-identical blocks.
 */

import { RESPONSE_MARKER } from "../branding.js";
import { estimateTokens, utf8ByteLength } from "./common.js";
import type { GitDiff, GitLogEntry, GitShowResult, GitStatus, GitStatusFile } from "./ports.js";

/** One successfully read file section. */
export interface ReadItem {
  kind: "read";
  relPath: string;
  lines: string[];
  start: number;
  end: number;
  totalLines: number;
  byteCount: number;
  lineNumbers: boolean;
  /** True when the requested end was clamped to the file length. */
  clamped: boolean;
}

/** One omitted or refused item, always explained. */
export interface OmittedItem {
  kind: "omitted";
  relPath: string;
  reason: string;
}

export type ReadResultItem = ReadItem | OmittedItem;

/** One rendered operation result block, usable alone or inside a combined response. */
export interface ResponsePart {
  /** Section title (used as the `##` header of the block). */
  title: string;
  /** Content lines of the block (no marker, no leading `##` header). */
  lines: string[];
  /** Bytes of the substantive content (used for the bytes/tokens metadata). */
  bytes: number;
}

/** Rendered discovery results, produced by the discovery use cases. */
export interface TreeWalkResult {
  lines: string[];
  entryCount: number;
  excluded: number;
  limited: boolean;
}

export interface GlobWalkResult {
  matches: string[];
  excluded: number;
  limited: boolean;
}

export interface InspectPrincipalFile {
  relPath: string;
  byteCount: number;
  lines: string[];
  truncated: boolean;
}

export interface InspectResult {
  /** Scope label for the tree (repository-relative path or "repository root"). */
  scopeLabel: string;
  tree: TreeWalkResult;
  files: InspectPrincipalFile[];
  omitted: OmittedItem[];
}

export interface SearchResult {
  query: string;
  backend: string;
  matches: { relPath: string; line: number; content: string }[];
  excluded: number;
  limited: boolean;
}

/**
 * Render selected lines with `N | ` numbering (width aligned to the last
 * selected line). Shared by the terminal printer and the response formatter.
 */
export function renderLines(lines: string[], start: number, lineNumbers: boolean): string {
  if (!lineNumbers) {
    return lines.join("\n");
  }
  const width = String(start + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(start + i).padStart(width, " ")} | ${line}`)
    .join("\n");
}

/** Wrap content lines in the protocol envelope (`RESPONSE_MARKER` + body). */
export function buildEnvelope(lines: string[]): string {
  return [RESPONSE_MARKER, "", ...lines].join("\n") + "\n";
}

/** Build the full protocol response for a set of read results (legacy shape). */
export function buildReadResponse(items: ReadResultItem[]): string {
  return buildEnvelope(["## Read summary", ...buildReadSummaryLines(items)]);
}

/**
 * The read block content (summary, omitted items, and file sections), without
 * the `## Read summary` header. Shared by the single-read response and by
 * read operations inside combined requests.
 */
export function buildReadSummaryLines(items: ReadResultItem[]): string[] {
  const readItems = items.filter((i): i is ReadItem => i.kind === "read");
  const omittedItems = items.filter((i): i is OmittedItem => i.kind === "omitted");
  const bytes = readItems.reduce((sum, item) => sum + item.byteCount, 0);

  const lines: string[] = [
    `Requested: ${items.length} | Read: ${readItems.length} | Omitted: ${omittedItems.length}`,
    `bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`,
  ];

  if (omittedItems.length > 0) {
    lines.push("", "## Omitted");
    for (const item of omittedItems) {
      lines.push(`- ${item.relPath} — ${item.reason}`);
    }
  }

  for (const item of readItems) {
    lines.push("", `## ${item.relPath}`);
    const rangeNote = item.clamped ? " (clamped to file length)" : "";
    lines.push(
      `Lines ${item.start}-${item.end} of ${item.totalLines} | ${item.byteCount} bytes${rangeNote}`,
    );
    lines.push(renderLines(item.lines, item.start, item.lineNumbers));
  }
  return lines;
}

/** Read operation part for combined responses. */
export function buildReadPart(items: ReadResultItem[], title: string): ResponsePart {
  const readItems = items.filter((i): i is ReadItem => i.kind === "read");
  const bytes = readItems.reduce((sum, item) => sum + item.byteCount, 0);
  return { title, lines: buildReadSummaryLines(items), bytes };
}

/** Tree operation part. */
export function buildTreePart(result: TreeWalkResult, depth: number, maxEntries: number): ResponsePart {
  const limitedNote = result.limited ? ` | limited: yes (max ${maxEntries})` : "";
  const bytes = utf8ByteLength(result.lines.join("\n"));
  return {
    title: `Tree (depth ${depth}, max ${maxEntries} entries)`,
    lines: [
      `Entries: ${result.entryCount} | Excluded: ${result.excluded}${limitedNote}`,
      `bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`,
      "",
      ...result.lines,
    ],
    bytes,
  };
}

/** Glob operation part. */
export function buildGlobPart(result: GlobWalkResult, pattern: string, maxResults: number): ResponsePart {
  const limitedNote = result.limited ? ` | limited: yes (max ${maxResults})` : "";
  const bytes = utf8ByteLength(result.matches.join("\n"));
  return {
    title: `Glob "${pattern}" (max ${maxResults} matches)`,
    lines: [
      `Matches: ${result.matches.length} | Excluded: ${result.excluded}${limitedNote}`,
      `bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`,
      "",
      ...result.matches.map((m) => `- ${m}`),
    ],
    bytes,
  };
}

/** Inspect operation part. */
export function buildInspectPart(
  result: InspectResult,
  depth: number,
  maxEntries: number,
  scopeRefused: string | null,
): ResponsePart {
  if (scopeRefused !== null) {
    return {
      title: `Inspect ${result.scopeLabel}`,
      lines: ["Scope refused — " + scopeRefused],
      bytes: utf8ByteLength(scopeRefused),
    };
  }

  const treeLimited = result.tree.limited ? ` | limited: yes (max ${maxEntries})` : "";
  const treeBytes = utf8ByteLength(result.tree.lines.join("\n"));
  const fileBytes = result.files.reduce((sum, f) => sum + f.byteCount, 0);
  const bytes = treeBytes + fileBytes;

  const lines: string[] = [
    `Tree (depth ${depth}, max ${maxEntries}): ${result.tree.entryCount} entries | ` +
      `${result.tree.excluded} excluded${treeLimited}`,
    ...result.tree.lines,
    "",
    `Principal files (${result.files.length}):`,
  ];
  for (const file of result.files) {
    lines.push(`- ${file.relPath} (${file.byteCount} bytes)`);
    for (const line of file.lines) {
      lines.push(`  ${line}`);
    }
    if (file.truncated) {
      lines.push("  … (content truncated to the first lines)");
    }
  }
  if (result.omitted.length > 0) {
    lines.push("", "Omitted principal files:");
    for (const item of result.omitted) {
      lines.push(`- ${item.relPath} — ${item.reason}`);
    }
  }
  lines.push("", `bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`);

  return {
    title: `Inspect ${result.scopeLabel}`,
    lines,
    bytes,
  };
}

/** Search operation part. */
export function buildSearchPart(result: SearchResult, maxResults: number): ResponsePart {
  const limitedNote = result.limited ? ` | limited: yes (max ${maxResults})` : "";
  const bytes = utf8ByteLength(
    result.matches.map((m) => `${m.relPath}:${m.line}`).join("\n"),
  );
  return {
    title: `Search "${result.query}" (${result.backend})`,
    lines: [
      `Matches: ${result.matches.length} | Excluded: ${result.excluded}${limitedNote}`,
      `bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`,
      "",
      ...result.matches.map((m) => `- ${m.relPath}:${m.line} | ${m.content}`),
    ],
    bytes,
  };
}

/** Merge several operation parts into one combined protocol response. */
export function buildCombinedResponse(parts: ResponsePart[]): string {
  const lines: string[] = [];
  for (const part of parts) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`## ${part.title}`);
    lines.push(...part.lines);
  }
  return buildEnvelope(lines);
}

/**
 * Batch envelope: the combined sections plus a summary header with the total
 * byte/token metadata and the configured limits, so the LLM sees the budget
 * it is working against in every batch response.
 */
export function buildBatchResponse(
  parts: ResponsePart[],
  maxBatchBytes: number,
  perFileBytes: number,
): string {
  const bytes = parts.reduce((sum, part) => sum + part.bytes, 0);
  const lines: string[] = [
    "## Batch response",
    `Operations: ${parts.length} | bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`,
    `limits: total ≤ ${maxBatchBytes} bytes | per-file ≤ ${perFileBytes} bytes`,
  ];
  for (const part of parts) {
    lines.push("", `## ${part.title}`);
    lines.push(...part.lines);
  }
  return buildEnvelope(lines);
}

/** One requested section with its rendered size, used by the recovery response. */
export interface CostlySection {
  title: string;
  bytes: number;
}

/**
 * Structured recovery response copied instead of an oversized context: names
 * the most expensive requested sections and asks the LLM to reduce scope.
 * Fails closed — the full content is never copied nor silently truncated.
 */
export function buildRecoveryResponse(
  sections: CostlySection[],
  totalBytes: number,
  maxBytes: number,
): string {
  const sorted = sections
    .filter((s) => s.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const lines: string[] = [
    "## Response too large — reduce scope",
    `The full response would be ${totalBytes} bytes, over the configured total budget ` +
      `(max_batch_bytes = ${maxBytes} bytes), so it was not copied. This recovery response ` +
      `was copied instead.`,
  ];
  if (sorted.length > 0) {
    lines.push("", "Most expensive requested sections:");
    for (const section of sorted.slice(0, 10)) {
      lines.push(`- ${section.title}: ${section.bytes} bytes`);
    }
  }
  lines.push(
    "",
    "Request fewer or smaller sections (smaller file ranges, narrower limits, fewer operations) and retry.",
  );
  return buildEnvelope(lines);
}

/** Count `status.files` per state bucket (returns 0 for missing buckets). */
function countState(files: GitStatusFile[], state: GitStatusFile["state"]): number {
  return files.filter((f) => f.state === state).length;
}

/** Status block: branch, per-state counts, and one list per non-empty bucket. */
export function buildStatusPart(status: GitStatus): ResponsePart {
  const staged = countState(status.files, "staged");
  const modified = countState(status.files, "modified");
  const untracked = countState(status.files, "untracked");
  const deleted = countState(status.files, "deleted");

  const lines: string[] = [
    `Branch: ${status.branch ?? "(detached HEAD)"}`,
    `Staged: ${staged} | Modified: ${modified} | Untracked: ${untracked} | Deleted: ${deleted}`,
    `bytes: ${0} | tokens: ~${0}`,
  ];
  if (status.files.length === 0) {
    lines.push("Working tree clean.");
    const bytes = utf8ByteLength(lines.join("\n"));
    lines[2] = `bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`;
    return { title: "Status", lines, bytes };
  }

  const buckets: Array<[string, GitStatusFile["state"]]> = [
    ["Staged", "staged"],
    ["Modified", "modified"],
    ["Untracked", "untracked"],
    ["Deleted", "deleted"],
  ];
  for (const [label, state] of buckets) {
    const files = status.files.filter((f) => f.state === state);
    if (files.length === 0) {
      continue;
    }
    lines.push("", `${label}:`);
    for (const file of files) {
      lines.push(`- ${file.relPath}`);
    }
  }

  const bytes = utf8ByteLength(lines.join("\n"));
  lines[2] = `bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`;
  return { title: "Status", lines, bytes };
}

/** Changed-files block: one flat list of files with their state bucket. */
export function buildChangedPart(status: GitStatus, scope: string | null): ResponsePart {
  const staged = countState(status.files, "staged");
  const modified = countState(status.files, "modified");
  const untracked = countState(status.files, "untracked");
  const deleted = countState(status.files, "deleted");

  const lines: string[] = [
    `Files: ${status.files.length} | Staged: ${staged} | Modified: ${modified} | ` +
      `Untracked: ${untracked} | Deleted: ${deleted}`,
    `bytes: ${0} | tokens: ~${0}`,
  ];
  if (status.files.length === 0) {
    lines.push("No changes.");
  } else {
    for (const file of status.files) {
      lines.push(`- ${file.relPath} (${file.state})`);
    }
  }

  const bytes = utf8ByteLength(lines.join("\n"));
  lines[1] = `bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`;
  return {
    title: scope !== null ? `Changed ${scope}` : "Changed",
    lines,
    bytes,
  };
}

/** Diff block: summary numbers plus the diff text itself. */
export function buildDiffPart(diff: GitDiff, scope: string | null, staged: boolean): ResponsePart {
  const label = staged ? "staged" : "working tree";
  const title = scope !== null ? `Diff ${scope} (${label})` : `Diff (${label})`;

  const lines: string[] = [
    `Files: ${diff.files} | Insertions: ${diff.insertions} | Deletions: ${diff.deletions}`,
    `bytes: ${0} | tokens: ~${0}`,
  ];
  if (diff.text === "") {
    lines.push("No changes.");
  } else {
    lines.push("", diff.text.replace(/\n$/, ""));
  }

  const bytes = utf8ByteLength(lines.join("\n"));
  lines[1] = `bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`;
  return { title, lines, bytes };
}

/** Log block: bounded recent commits, one line each. */
export function buildLogPart(
  entries: GitLogEntry[],
  scope: string | null,
  maxCommits: number,
): ResponsePart {
  const title = scope !== null ? `Log ${scope} (${entries.length} commits)` : `Log (${entries.length} commits)`;
  const limitedNote =
    entries.length > 0 && entries.length >= maxCommits
      ? ` | limited: yes (max ${maxCommits})`
      : "";
  const lines: string[] = [
    `Commits: ${entries.length}${limitedNote}`,
    `bytes: ${0} | tokens: ~${0}`,
  ];
  if (entries.length === 0) {
    lines.push("No commits.");
  } else {
    for (const entry of entries) {
      lines.push(`- ${entry.shortHash} ${entry.date} ${entry.subject}`);
    }
  }

  const bytes = utf8ByteLength(lines.join("\n"));
  lines[1] = `bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`;
  return { title, lines, bytes };
}

/** Show block: blob content at a revision, or the Git diagnostic. */
export function buildShowPart(result: GitShowResult, rev: string, path: string): ResponsePart {
  const title = `Show ${rev}:${path}`;
  if (!result.ok) {
    const lines = [`Not shown — ${result.error}`];
    const bytes = utf8ByteLength(lines.join("\n"));
    return { title, lines, bytes };
  }
  const lines = [`bytes: ${0} | tokens: ~${0}`, "", result.content];
  const bytes = utf8ByteLength(lines.join("\n"));
  lines[0] = `bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`;
  return { title, lines, bytes };
}

/** Structured refusal response for a malformed or unsupported request. */
export function buildRefusalResponse(reason: string, supported: string): string {
  return [
    RESPONSE_MARKER,
    "",
    "## Request refused",
    reason,
    `This build supports: ${supported}`,
  ].join("\n") + "\n";
}