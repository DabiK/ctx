/**
 * Stable `# CTX RESPONSE` formatting for read operations (application logic).
 *
 * Copied output is always the protocol response; direct terminal reads print
 * the same file sections without the protocol envelope. The formatter is the
 * single source of the response shape so direct `--copy` and clipboard-driven
 * requests produce byte-identical blocks.
 */

import { RESPONSE_MARKER } from "../branding.js";
import { estimateTokens } from "./common.js";

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

export interface ReadResponseOptions {
  lineNumbers: boolean;
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

/** Build the full protocol response for a set of read results. */
export function buildReadResponse(items: ReadResultItem[]): string {
  const readItems = items.filter((i): i is ReadItem => i.kind === "read");
  const omittedItems = items.filter((i): i is OmittedItem => i.kind === "omitted");
  const bytes = readItems.reduce((sum, item) => sum + item.byteCount, 0);

  const sections: string[] = [`${RESPONSE_MARKER}`];
  sections.push("");
  sections.push("## Read summary");
  sections.push(
    `Requested: ${items.length} | Read: ${readItems.length} | Omitted: ${omittedItems.length}`,
  );
  sections.push(`bytes: ${bytes} | tokens: ~${estimateTokens(bytes)}`);

  if (omittedItems.length > 0) {
    sections.push("");
    sections.push("## Omitted");
    for (const item of omittedItems) {
      sections.push(`- ${item.relPath} — ${item.reason}`);
    }
  }

  for (const item of readItems) {
    sections.push("");
    sections.push(`## ${item.relPath}`);
    const rangeNote = item.clamped ? " (clamped to file length)" : "";
    sections.push(
      `Lines ${item.start}-${item.end} of ${item.totalLines} | ${item.byteCount} bytes${rangeNote}`,
    );
    sections.push(renderLines(item.lines, item.start, item.lineNumbers));
  }

  return sections.join("\n") + "\n";
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