/**
 * `ctx status` / `ctx changed` / `ctx diff` / `ctx log` / `ctx show`
 * application use case.
 *
 * Read-only Git context operations through the repository permission
 * boundary. The Git port is a fixed allowlist of well-defined read-only
 * invocations; the use case applies the same path rules as file reads
 * (repository-relative, allowed roots, `.ctxignore`, sensitive paths) to
 * every scoped path and refuses anything else before a Git command runs.
 * `show` validates its revision and path syntactically and reads only from
 * the object store, so existence is left to Git itself.
 *
 * Direct commands print the sections to the terminal and copy the stable
 * protocol response only with `--copy`; protocol-driven requests collect the
 * rendered blocks for a combined response.
 */

import { CONFIG_FILE_NAME, PRODUCT_NAME } from "../branding.js";
import { parseProjectConfig, type ProjectConfig } from "../config.js";
import { isSafeRevision, isSafeShowPath } from "../protocol.js";
import { PathGuard } from "./boundary.js";
import { EXIT_FAILURE, finishDiscoveryOp, requireGitRoot, utf8ByteLength } from "./common.js";
import type { DiscoveryOptions, OpExecution } from "./discovery.js";
import type {
  ClipboardPort,
  FsPort,
  GitDiff,
  GitPort,
  GitShowResult,
  GitStatus,
  TerminalPort,
} from "./ports.js";
import {
  buildChangedPart,
  buildDiffPart,
  buildLogPart,
  buildShowPart,
  buildStatusPart,
  type ResponsePart,
} from "./response.js";

/** Options shared by the direct Git context commands (extends discovery). */
export interface GitOptions extends DiscoveryOptions {
  /** CLI `--limit` override (log), overrides the configured max_results. */
  limit?: number | null;
}

/** Repository context shared by the Git operations. */
interface GitContext {
  root: string;
  config: ProjectConfig;
  guard: PathGuard;
}

/** Validated scope path of a Git operation, or an explained refusal part. */
interface GitScope {
  /** `null` when the operation is unscoped. */
  relPath: string | null;
  /** Refusal part to render when the scope path is not acceptable. */
  refusedPart: ResponsePart | null;
}

export class GitUseCase {
  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
  ) {}

  /** `ctx status` — branch and per-state changed files. */
  async status(opts: GitOptions): Promise<number> {
    const exec = await this.collectStatus(opts.allowSensitive);
    if (exec === null) {
      return EXIT_FAILURE;
    }
    return finishDiscoveryOp(exec, opts, this.clipboard, this.terminal);
  }

  /** `ctx changed [path]` — flat changed-file list, optionally scoped. */
  async changed(path: string | null, opts: GitOptions): Promise<number> {
    const exec = await this.collectChanged(path, opts.allowSensitive);
    if (exec === null) {
      return EXIT_FAILURE;
    }
    return finishDiscoveryOp(exec, opts, this.clipboard, this.terminal);
  }

  /** `ctx diff [--staged] [path]` — working-tree or staged diff. */
  async diff(path: string | null, staged: boolean, opts: GitOptions): Promise<number> {
    const exec = await this.collectDiff(path, staged, opts.allowSensitive);
    if (exec === null) {
      return EXIT_FAILURE;
    }
    return finishDiscoveryOp(exec, opts, this.clipboard, this.terminal);
  }

  /** `ctx log [path]` — bounded recent commits, optionally scoped. */
  async log(path: string | null, opts: GitOptions): Promise<number> {
    const exec = await this.collectLog(path, opts.allowSensitive, opts.limit ?? null);
    if (exec === null) {
      return EXIT_FAILURE;
    }
    return finishDiscoveryOp(exec, opts, this.clipboard, this.terminal);
  }

  /** `ctx show <rev> <path>` — a blob read from the object store. */
  async show(rev: string, path: string, opts: GitOptions): Promise<number> {
    const exec = await this.collectShow(rev, path, opts.allowSensitive);
    if (exec === null) {
      return EXIT_FAILURE;
    }
    return finishDiscoveryOp(exec, opts, this.clipboard, this.terminal);
  }

  /** Collect the status block without copying/printing (request use case). */
  async collectStatus(allowSensitive: boolean): Promise<OpExecution | null> {
    const ctx = await this.openContext(allowSensitive);
    if (ctx === null) {
      return null;
    }
    let status: GitStatus;
    try {
      status = await this.git.status(ctx.root);
    } catch (err) {
      this.reportGitFailure(err);
      return null;
    }
    return { part: buildStatusPart(status), produced: status.files.length > 0 };
  }

  /** Collect the changed block without copying/printing (request use case). */
  async collectChanged(path: string | null, allowSensitive: boolean): Promise<OpExecution | null> {
    const ctx = await this.openContext(allowSensitive);
    if (ctx === null) {
      return null;
    }
    const scope = this.scopeOrRefusal(ctx, path, "Changed");
    if (scope.refusedPart !== null) {
      return { part: scope.refusedPart, produced: false };
    }
    let status: GitStatus;
    try {
      status = await this.git.status(ctx.root);
    } catch (err) {
      this.reportGitFailure(err);
      return null;
    }
    const files =
      scope.relPath === null
        ? status.files
        : status.files.filter((f) =>
            this.fs.isWithin(this.fs.join(ctx.root, scope.relPath ?? ""), this.fs.join(ctx.root, f.relPath)),
          );
    return {
      part: buildChangedPart({ branch: status.branch, files }, path),
      produced: files.length > 0,
    };
  }

  /** Collect the diff block without copying/printing (request use case). */
  async collectDiff(
    path: string | null,
    staged: boolean,
    allowSensitive: boolean,
  ): Promise<OpExecution | null> {
    const ctx = await this.openContext(allowSensitive);
    if (ctx === null) {
      return null;
    }
    const scope = this.scopeOrRefusal(ctx, path, "Diff");
    if (scope.refusedPart !== null) {
      return { part: scope.refusedPart, produced: false };
    }
    let diff: GitDiff;
    try {
      diff = await this.git.diff(ctx.root, scope.relPath, staged);
    } catch (err) {
      this.reportGitFailure(err);
      return null;
    }
    return {
      part: buildDiffPart(diff, path, staged),
      produced: diff.files > 0,
    };
  }

  /** Collect the log block without copying/printing (request use case). */
  async collectLog(
    path: string | null,
    allowSensitive: boolean,
    limitOverride: number | null,
  ): Promise<OpExecution | null> {
    const ctx = await this.openContext(allowSensitive);
    if (ctx === null) {
      return null;
    }
    const maxCommits = clampResults(limitOverride ?? ctx.config.maxResults);
    const scope = this.scopeOrRefusal(ctx, path, "Log");
    if (scope.refusedPart !== null) {
      return { part: scope.refusedPart, produced: false };
    }
    let entries;
    try {
      entries = await this.git.log(ctx.root, scope.relPath, maxCommits);
    } catch (err) {
      this.reportGitFailure(err);
      return null;
    }
    return {
      part: buildLogPart(entries, path, maxCommits),
      produced: entries.length > 0,
    };
  }

  /** Collect the show block without copying/printing (request use case). */
  async collectShow(
    rev: string,
    path: string,
    allowSensitive: boolean,
  ): Promise<OpExecution | null> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return null;
    }
    // Defensive re-validation: the protocol parser and CLI already refuse
    // unsafe forms, but show must never forward an arbitrary fragment.
    if (!isSafeRevision(rev) || !isSafeShowPath(path)) {
      const lines = [
        "Refused — show accepts only a safe revision (HEAD, hex hash, or plain branch/tag name) and a repository-relative path",
      ];
      return {
        part: { title: `Show ${rev}:${path}`, lines, bytes: utf8ByteLength(lines.join("\n")) },
        produced: false,
      };
    }
    let result: GitShowResult;
    try {
      result = await this.git.show(root, rev, path);
    } catch (err) {
      this.reportGitFailure(err);
      return null;
    }
    return { part: buildShowPart(result, rev, path), produced: result.ok };
  }

  /** Resolve the repository root, project config, and permission boundary. */
  private async openContext(allowSensitive: boolean): Promise<GitContext | null> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return null;
    }
    const config = parseProjectConfig(this.fs.readText(this.fs.join(root, CONFIG_FILE_NAME)));
    return { root, config, guard: new PathGuard(root, config, allowSensitive, this.fs) };
  }

  /** Report an unexpected Git port failure. */
  private reportGitFailure(err: unknown): void {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    this.terminal.error(`${PRODUCT_NAME}: Git operation failed${detail}`);
  }

  /**
   * Validate an optional scope path against the boundary. Refusals become an
   * explained part (never a silent filter); valid paths resolve to a
   * repository-relative scope handed to the Git port.
   */
  private scopeOrRefusal(ctx: GitContext, path: string | null, opLabel: string): GitScope {
    if (path === null) {
      return { relPath: null, refusedPart: null };
    }
    const guarded = ctx.guard.guardDir(path);
    if (!guarded.ok) {
      const lines = [`Scope refused — ${guarded.reason}`];
      return {
        relPath: null,
        refusedPart: {
          title: `${opLabel} ${path}`,
          lines,
          bytes: utf8ByteLength(lines.join("\n")),
        },
      };
    }
    return { relPath: guarded.relPath, refusedPart: null };
  }
}

/** Clamp a commit limit to the supported range. */
function clampResults(limit: number): number {
  return Math.min(Math.max(1, Math.floor(limit)), 1000);
}