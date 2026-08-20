/**
 * Content-search backends (outbound adapters).
 *
 * ripgrep is the preferred backend; findstr is the Windows-native fallback
 * used only when ripgrep is absent. Both return raw matches; `.ctxignore`,
 * allowed-root, and sensitive rules are applied uniformly by the application
 * search use case so the two backends obey the same contract. Output parsers
 * are pure functions so they stay unit-testable on any host.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EnvPort, SearchMatch, SearchPort } from "../application/ports.js";

const execFileAsync = promisify(execFile);

const BACKEND_TIMEOUT = 15_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/** Pick the search backend: ripgrep when available, findstr on Windows, else a stub. */
export function createSearchPort(env: EnvPort): SearchPort {
  if (env.executableAvailable("rg")) {
    return new RipgrepSearch();
  }
  if (env.platform === "win32") {
    return new FindstrSearch();
  }
  return new MissingSearchPort();
}

/**
 * Search backend on hosts with neither ripgrep nor the Windows fallback.
 * Fails only when actually used, so unrelated commands (and `ctx doctor`)
 * keep working on unsupported hosts.
 */
export class MissingSearchPort implements SearchPort {
  readonly name = "unavailable";

  async search(_query: string, _roots: string[], _limit: number): Promise<SearchMatch[]> {
    throw new Error("ripgrep is required for search on this platform — run `ctx doctor` for install instructions");
  }
}

/** ripgrep backend. */
export class RipgrepSearch implements SearchPort {
  readonly name = "ripgrep";

  async search(query: string, roots: string[], limit: number): Promise<SearchMatch[]> {
    const root = roots[0] ?? "";
    try {
      const { stdout } = await execFileAsync(
        "rg",
        [
          "--json",
          "--no-heading",
          "-S",
          "--no-ignore",
          "--max-count",
          String(limit),
          "--",
          query,
          ...roots,
        ],
        { timeout: BACKEND_TIMEOUT, maxBuffer: MAX_BUFFER },
      );
      return parseRipgrepJson(stdout, root);
    } catch (err) {
      // rg exits 1 when no matches are found — an empty result, not a failure.
      if (isNoMatchExit(err)) {
        return [];
      }
      throw err;
    }
  }
}

/** Windows-native fallback (findstr) backend. */
export class FindstrSearch implements SearchPort {
  readonly name = "findstr";

  async search(query: string, roots: string[], limit: number): Promise<SearchMatch[]> {
    // findstr cannot take newlines in a search string; collapse them.
    const safeQuery = query.replace(/[\r\n]+/g, " ").trim();
    if (safeQuery === "") {
      return [];
    }
    const matches: SearchMatch[] = [];
    for (const root of roots) {
      try {
        const { stdout } = await execFileAsync(
          "findstr",
          ["/n", "/s", "/i", `/c:${safeQuery}`, join(root, "*")],
          { timeout: BACKEND_TIMEOUT, maxBuffer: MAX_BUFFER },
        );
        for (const match of parseFindstrOutput(stdout, root)) {
          matches.push(match);
          if (matches.length >= limit) {
            return matches.slice(0, limit);
          }
        }
      } catch (err) {
        // findstr exits 1 when no matches are found.
        if (!isNoMatchExit(err)) {
          throw err;
        }
      }
    }
    return matches.slice(0, limit);
  }
}

/** Parse `rg --json` output into matches (pure, exported for tests). */
export function parseRipgrepJson(stdout: string, root: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.trim() === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const object = parsed as { type?: unknown; data?: unknown };
    if (object.type !== "match") {
      continue;
    }
    const data = object.data as
      | { path?: { text?: unknown }; lines?: { text?: unknown }; line_number?: unknown }
      | null
      | undefined;
    const pathText = data?.path?.text;
    const lineText = data?.lines?.text;
    const lineNumber = data?.line_number;
    if (typeof pathText !== "string" || typeof lineText !== "string") {
      continue;
    }
    if (typeof lineNumber !== "number" || !Number.isInteger(lineNumber) || lineNumber < 1) {
      continue;
    }
    const relPath = relFromRoot(root, pathText);
    if (relPath === null) {
      continue;
    }
    matches.push({
      relPath,
      line: lineNumber,
      content: lineText.replace(/\r?\n$/, ""),
    });
  }
  return matches;
}

/** Parse `findstr /n /s` output (`path:line:content`) into matches (pure). */
export function parseFindstrOutput(stdout: string, root: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw === "") {
      continue;
    }
    const parsed = /^(.+):(\d+):(.*)$/.exec(raw);
    if (parsed === null) {
      continue;
    }
    const [, file, lineStr, content] = parsed;
    const line = Number(lineStr);
    if (!Number.isInteger(line) || line < 1) {
      continue;
    }
    const relPath = relFromRoot(root, file ?? "");
    if (relPath === null) {
      continue;
    }
    matches.push({ relPath, line, content: (content ?? "").replace(/\r$/, "") });
  }
  return matches;
}

/** True when an execFile error is the "no matches" exit code (1). */
function isNoMatchExit(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 1;
}

/**
 * Compute a forward-slash repository-relative path for `absPath` under
 * `root`, or `null` when `absPath` is outside the root. Works for both `/`
 * and `\` separators so the two backends share one deterministic contract.
 */
function relFromRoot(root: string, absPath: string): string | null {
  const normRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normPath = absPath.replace(/\\/g, "/");
  if (normPath === normRoot) {
    return "";
  }
  if (normPath.startsWith(normRoot + "/")) {
    return normPath.slice(normRoot.length + 1);
  }
  return null;
}