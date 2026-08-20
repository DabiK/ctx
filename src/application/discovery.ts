/**
 * `ctx tree` / `ctx glob` / `ctx inspect` application use case.
 *
 * Project discovery through the repository permission boundary. All three
 * operations walk the repository with the filesystem port, honouring the same
 * `.ctxignore`, sensitive-path, and allowed-root rules as file reads, and
 * report limits explicitly instead of pretending the result is complete.
 * Direct commands print the sections to the terminal and copy the stable
 * protocol response only with `--copy`; protocol-driven requests collect the
 * rendered blocks for a combined response.
 */

import { CONFIG_FILE_NAME } from "../branding.js";
import { parseProjectConfig, type ProjectConfig } from "../config.js";
import { globToRegexSource } from "../ignore.js";
import { containsSensitiveContent } from "../sensitive.js";
import { PathGuard } from "./boundary.js";
import { EXIT_FAILURE, finishDiscoveryOp, requireGitRoot, utf8ByteLength } from "./common.js";
import type { ClipboardPort, FsPort, GitPort, TerminalPort } from "./ports.js";
import {
  buildGlobPart,
  buildInspectPart,
  buildTreePart,
  type GlobWalkResult,
  type InspectPrincipalFile,
  type InspectResult,
  type OmittedItem,
  type ResponsePart,
  type TreeWalkResult,
} from "./response.js";

/** Principal files shown by `inspect` (repo-root module/documentation files). */
const PRINCIPAL_FILES = [
  "package.json",
  "README.md",
  "AGENTS.md",
  "tsconfig.json",
  ".ctx.toml",
  ".ctxignore",
];

/** Content lines shown per principal file in `inspect`. */
const PRINCIPAL_LINE_LIMIT = 40;

export interface DiscoveryOptions {
  copy: boolean;
  allowSensitive: boolean;
  /** Protocol-driven operations never print raw content and always copy. */
  protocol: boolean;
  /** CLI `--limit` override (glob/search), overrides the configured max_results. */
  limit?: number | null;
  /** CLI `--depth` override (inspect), overrides the configured inspect_depth. */
  depth?: number | null;
}

/** Result of one operation execution, ready to render. */
export interface OpExecution {
  part: ResponsePart;
  /** True when the operation produced substantive content (drives exit codes). */
  produced: boolean;
}

/** Repository context shared by all discovery walks. */
interface DiscoveryContext {
  root: string;
  config: ProjectConfig;
  guard: PathGuard;
}

export class DiscoveryUseCase {
  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
  ) {}

  /** `ctx tree [--depth N]` — bounded directory tree from the repository root. */
  async tree(depth: number | null, opts: DiscoveryOptions): Promise<number> {
    const exec = await this.collectTree(depth, opts.allowSensitive);
    if (exec === null) {
      return EXIT_FAILURE;
    }
    return this.finish(exec, opts);
  }

  /** `ctx glob <pattern>` — pattern-matched file list. */
  async glob(pattern: string, opts: DiscoveryOptions): Promise<number> {
    const exec = await this.collectGlob(pattern, opts.allowSensitive, opts.limit ?? null);
    if (exec === null) {
      return EXIT_FAILURE;
    }
    return this.finish(exec, opts);
  }

  /** `ctx inspect [path]` — bounded tree plus principal files and module metadata. */
  async inspect(path: string | null, opts: DiscoveryOptions): Promise<number> {
    const exec = await this.collectInspect(path, opts.allowSensitive, opts.depth ?? null);
    if (exec === null) {
      return EXIT_FAILURE;
    }
    return this.finish(exec, opts);
  }

  /** Collect the tree block without copying/printing (used by the request use case). */
  async collectTree(depth: number | null, allowSensitive: boolean): Promise<OpExecution | null> {
    const ctx = await this.openContext(allowSensitive);
    if (ctx === null) {
      return null;
    }
    const d = clampDepth(depth ?? ctx.config.treeDepth);
    const maxEntries = clampResults(ctx.config.maxResults);
    const walk = this.walkTree(ctx, d, maxEntries);
    return { part: buildTreePart(walk, d, maxEntries), produced: walk.entryCount > 0 };
  }

  /** Collect the glob block without copying/printing (used by the request use case). */
  async collectGlob(
    pattern: string,
    allowSensitive: boolean,
    limitOverride: number | null,
  ): Promise<OpExecution | null> {
    const ctx = await this.openContext(allowSensitive);
    if (ctx === null) {
      return null;
    }
    const maxResults = clampResults(limitOverride ?? ctx.config.maxResults);
    const walk = this.walkGlob(ctx, pattern, maxResults);
    return { part: buildGlobPart(walk, pattern, maxResults), produced: walk.matches.length > 0 };
  }

  /** Collect the inspect block without copying/printing (used by the request use case). */
  async collectInspect(
    path: string | null,
    allowSensitive: boolean,
    depthOverride: number | null,
  ): Promise<OpExecution | null> {
    const ctx = await this.openContext(allowSensitive);
    if (ctx === null) {
      return null;
    }
    const depth = clampDepth(depthOverride ?? ctx.config.inspectDepth);
    const maxEntries = clampResults(ctx.config.maxResults);
    const scopeLabel = path ?? "repository root";

    let scopeAbs = ctx.root;
    let scopeRefused: string | null = null;
    if (path !== null) {
      const guarded = ctx.guard.guardDir(path);
      if (!guarded.ok) {
        scopeRefused = guarded.reason;
      } else {
        scopeAbs = guarded.absPath;
      }
    }

    let tree: TreeWalkResult = { lines: [], entryCount: 0, excluded: 0, limited: false };
    if (scopeRefused === null) {
      tree = this.walkTreeAt(ctx, scopeAbs, path ?? "", depth, maxEntries);
    }
    const { files, omitted } = this.collectPrincipalFiles(ctx, allowSensitive);

    const result: InspectResult = { scopeLabel, tree, files, omitted };
    return {
      part: buildInspectPart(result, depth, maxEntries, scopeRefused),
      produced: scopeRefused === null && (tree.entryCount > 0 || files.length > 0),
    };
  }

  /** Shared execution tail: copy on demand, print, and compute the exit code. */
  private async finish(exec: OpExecution, opts: DiscoveryOptions): Promise<number> {
    return finishDiscoveryOp(exec, opts, this.clipboard, this.terminal);
  }

  /** Resolve the repository root, project config, and permission boundary. */
  private async openContext(allowSensitive: boolean): Promise<DiscoveryContext | null> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return null;
    }
    const config = parseProjectConfig(this.fs.readText(this.fs.join(root, CONFIG_FILE_NAME)));
    return { root, config, guard: new PathGuard(root, config, allowSensitive, this.fs) };
  }

  /** Bounded tree walk from the repository root. */
  private walkTree(ctx: DiscoveryContext, maxDepth: number, maxEntries: number): TreeWalkResult {
    return this.walkTreeAt(ctx, ctx.root, "", maxDepth, maxEntries);
  }

  /** Bounded tree walk rooted at `scopeAbs`, with `relPrefix` rel paths. */
  private walkTreeAt(
    ctx: DiscoveryContext,
    scopeAbs: string,
    relPrefix: string,
    maxDepth: number,
    maxEntries: number,
  ): TreeWalkResult {
    const lines: string[] = [];
    let entryCount = 0;
    let excluded = 0;
    let limited = false;

    const visit = (absDir: string, relDir: string, depth: number): void => {
      if (limited) {
        return;
      }
      const names = [...this.fs.readDir(absDir)].sort();
      for (const name of names) {
        if (limited) {
          return;
        }
        const abs = this.fs.join(absDir, name);
        const rel = relDir === "" ? name : `${relDir}/${name}`;
        if (!ctx.guard.entryAllowed(rel).ok) {
          excluded++;
          continue;
        }
        const isDir = this.fs.isDirectory(abs);
        lines.push("  ".repeat(depth - 1) + name + (isDir ? "/" : ""));
        entryCount++;
        if (entryCount >= maxEntries) {
          limited = true;
          return;
        }
        if (isDir && depth < maxDepth) {
          visit(abs, rel, depth + 1);
        }
      }
    };

    visit(scopeAbs, relPrefix, 1);
    return { lines, entryCount, excluded, limited };
  }

  /** Glob walk: files matching `pattern`, bounded by `maxResults` matches. */
  private walkGlob(ctx: DiscoveryContext, pattern: string, maxResults: number): GlobWalkResult {
    const matcher = compileGlobMatcher(pattern);
    const matches: string[] = [];
    let excluded = 0;
    let limited = false;

    const visit = (absDir: string, relDir: string): void => {
      if (limited) {
        return;
      }
      const names = [...this.fs.readDir(absDir)].sort();
      for (const name of names) {
        if (limited) {
          return;
        }
        const abs = this.fs.join(absDir, name);
        const rel = relDir === "" ? name : `${relDir}/${name}`;
        if (!ctx.guard.entryAllowed(rel).ok) {
          excluded++;
          continue;
        }
        if (this.fs.isDirectory(abs)) {
          visit(abs, rel);
        } else if (matcher(rel)) {
          matches.push(rel);
          if (matches.length >= maxResults) {
            limited = true;
            return;
          }
        }
      }
    };

    visit(ctx.root, "");
    return { matches, excluded, limited };
  }

  /** Read the repo-root principal files, bounded and explained when omitted. */
  private collectPrincipalFiles(
    ctx: DiscoveryContext,
    allowSensitive: boolean,
  ): { files: InspectPrincipalFile[]; omitted: OmittedItem[] } {
    const files: InspectPrincipalFile[] = [];
    const omitted: OmittedItem[] = [];

    for (const candidate of PRINCIPAL_FILES) {
      if (files.length >= clampResults(ctx.config.maxResults)) {
        break;
      }
      const guarded = ctx.guard.guard(candidate);
      if (!guarded.ok) {
        omitted.push({ kind: "omitted", relPath: candidate, reason: guarded.reason });
        continue;
      }
      const content = this.fs.readText(guarded.absPath);
      if (content === null) {
        omitted.push({ kind: "omitted", relPath: candidate, reason: "unreadable file" });
        continue;
      }
      if (!allowSensitive && containsSensitiveContent(content)) {
        omitted.push({
          kind: "omitted",
          relPath: candidate,
          reason: "contains sensitive content — requires an explicit override to disclose",
        });
        continue;
      }

      const allLines = splitLines(content);
      const lines = candidate === "package.json"
        ? packageMetadata(content)
        : allLines.slice(0, PRINCIPAL_LINE_LIMIT).map((l) => l.trimEnd());
      files.push({
        relPath: candidate,
        byteCount: utf8ByteLength(content),
        lines,
        truncated: candidate !== "package.json" && allLines.length > PRINCIPAL_LINE_LIMIT,
      });
    }

    return { files, omitted };
  }
}

/** Clamp a depth to the supported range. */
function clampDepth(depth: number): number {
  return Math.min(Math.max(1, Math.floor(depth)), 10);
}

/** Clamp a result limit to the supported range. */
function clampResults(limit: number): number {
  return Math.min(Math.max(1, Math.floor(limit)), 1000);
}

/** Compile a glob pattern into a predicate over repository-relative paths. */
function compileGlobMatcher(pattern: string): (relPath: string) => boolean {
  // Double-star semantics: `**/` matches zero or more directories (also `/**`
  // at the end, and `/**/` in the middle), so `src/**/*.ts` matches both
  // `src/app.ts` and `src/lib/util.ts`. Sentinels survive globToRegexSource
  // (they are not glob or regex-special characters) and are expanded after.
  const withSentinels = pattern
    .replace(/\*\*\//g, "\u0000")
    .replace(/\/\*\*/g, "\u0001");
  let source = globToRegexSource(withSentinels)
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, "(?:/.*)?");
  // A pattern without a slash matches at any depth (gitignore-style globs,
  // consistent with .ctxignore vocabulary); slash patterns anchor to the root.
  if (!pattern.includes("/")) {
    source = "(?:.*/)?" + source;
  }
  const regex = new RegExp("^" + source + "$");
  return (relPath: string) => regex.test(relPath.replace(/\\/g, "/"));
}

/** Module metadata lines for a package.json principal file. */
function packageMetadata(content: string): string[] {
  let pkg: unknown;
  try {
    pkg = JSON.parse(content);
  } catch {
    return ["(unparseable package.json)"];
  }
  if (typeof pkg !== "object" || pkg === null) {
    return ["(unparseable package.json)"];
  }
  const record = pkg as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof record.name === "string") {
    lines.push(`name: ${record.name}`);
  }
  if (typeof record.version === "string") {
    lines.push(`version: ${record.version}`);
  }
  if (typeof record.description === "string") {
    lines.push(`description: ${record.description}`);
  }
  if (typeof record.type === "string") {
    lines.push(`type: ${record.type}`);
  }
  if (typeof record.main === "string") {
    lines.push(`main: ${record.main}`);
  }
  if (isStringRecord(record.scripts)) {
    const names = Object.keys(record.scripts);
    if (names.length > 0) {
      lines.push(`scripts: ${names.join(", ")}`);
    }
  }
  if (isStringRecord(record.dependencies)) {
    const names = Object.keys(record.dependencies);
    if (names.length > 0) {
      lines.push(`dependencies: ${names.join(", ")}`);
    }
  }
  if (lines.length === 0) {
    lines.push("(no module metadata fields)");
  }
  return lines;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Split file content into lines, dropping the empty trailing element. */
function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && (lines[lines.length - 1] ?? "") === "") {
    lines.pop();
  }
  return lines;
}