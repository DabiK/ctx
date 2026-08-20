/**
 * `ctx search` application use case.
 *
 * Delegates the content search to a SearchPort backend (ripgrep preferred,
 * Windows-native findstr fallback) and applies the same boundary rules as
 * file reads to every match: `.ctxignore`, sensitive paths, sensitive line
 * content, allowed roots, and an explicit result limit. Limits are reported
 * explicitly; the two backends therefore obey the same response contract.
 */

import { CONFIG_FILE_NAME, PRODUCT_NAME } from "../branding.js";
import { clampBatchBytes, parseProjectConfig } from "../config.js";
import { containsSensitiveContent } from "../sensitive.js";
import { PathGuard } from "./boundary.js";
import { EXIT_FAILURE, EXIT_OK, finishDiscoveryOp, requireGitRoot } from "./common.js";
import type {
  ClipboardPort,
  FsPort,
  GitPort,
  SearchMatch,
  SearchPort,
  TerminalPort,
} from "./ports.js";
import { buildSearchPart, type SearchResult } from "./response.js";
import type { DiscoveryOptions, OpExecution } from "./discovery.js";

/**
 * Fetch headroom over the display limit: the backend may return up to
 * `limit * HEADROOM` raw matches so boundary filtering does not starve the
 * visible results. Clamped to MAX_RESULTS.
 */
const FETCH_HEADROOM = 4;

export class SearchUseCase {
  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
    private readonly backend: SearchPort,
  ) {}

  /** `ctx search <query>...` — bounded content search. */
  async search(query: string, opts: DiscoveryOptions): Promise<number> {
    const exec = await this.collectSearch(query, opts.allowSensitive, opts.limit ?? null);
    if (exec === null) {
      return EXIT_FAILURE;
    }
    return finishDiscoveryOp(exec, opts, this.clipboard, this.terminal);
  }

  /** Collect the search block without copying/printing (used by the request use case). */
  async collectSearch(
    query: string,
    allowSensitive: boolean,
    limitOverride: number | null,
  ): Promise<OpExecution | null> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return null;
    }
    const config = parseProjectConfig(this.fs.readText(this.fs.join(root, CONFIG_FILE_NAME)));
    const guard = new PathGuard(root, config, allowSensitive, this.fs);

    const maxResults = clampResults(limitOverride ?? config.maxResults);
    const fetchLimit = Math.min(maxResults * FETCH_HEADROOM, 1000);

    let raw: SearchMatch[];
    try {
      raw = await this.backend.search(query, [root], fetchLimit);
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : "";
      this.terminal.error(
        `${PRODUCT_NAME}: search backend failed${detail} — install ripgrep or check \`${PRODUCT_NAME} doctor\`.`,
      );
      return null;
    }

    const matches: SearchMatch[] = [];
    let excluded = 0;
    let limited = false;
    for (const match of raw) {
      if (matches.length >= maxResults) {
        limited = true;
        break;
      }
      const guarded = guard.guard(match.relPath);
      if (!guarded.ok) {
        excluded++;
        continue;
      }
      if (!allowSensitive && containsSensitiveContent(match.content)) {
        excluded++;
        continue;
      }
      matches.push(match);
    }
    limited = limited || matches.length >= maxResults;

    const result: SearchResult = {
      query,
      backend: this.backend.name,
      matches,
      excluded,
      limited,
    };
    return {
      part: buildSearchPart(result, maxResults),
      produced: matches.length > 0,
      maxBatchBytes: clampBatchBytes(config.maxBatchBytes),
    };
  }
}

/** Clamp a result limit to the supported range. */
function clampResults(limit: number): number {
  return Math.min(Math.max(1, Math.floor(limit)), 1000);
}