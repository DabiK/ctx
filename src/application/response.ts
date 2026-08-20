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