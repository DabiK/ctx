/**
 * Repository permission boundary (application logic).
 *
 * A request path is acceptable only when it is repository-relative (no
 * absolute paths, no `..` traversal), resolves through symlinks to a target
 * inside an allowed root (the repository root plus configured `allowed_roots`
 * entries), is an existing file, and is not excluded by `.ctxignore` or a
 * sensitive-path pattern (unless an explicit override was given). Every
 * refusal happens before any content is read.
 */

import { CONFIG_FILE_NAME, IGNORE_FILE_NAME } from "../branding.js";
import type { ProjectConfig } from "../config.js";
import { compileIgnorePatterns, type CompiledIgnore } from "../ignore.js";
import { DEFAULT_SENSITIVE_PATTERNS } from "../sensitive.js";
import type { FsPort } from "./ports.js";

export type GuardResult =
  | { ok: true; kind: "ok"; absPath: string; relPath: string }
  | { ok: false; kind: "refused"; reason: string };

/** True for POSIX or Windows-style absolute paths. */
function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

export class PathGuard {
  private readonly fs: FsPort;
  private readonly root: string;
  private readonly ignoreMatcher: CompiledIgnore;
  private readonly sensitiveMatcher: CompiledIgnore;
  private readonly allowSensitive: boolean;
  private readonly allowedRoots: string[];

  constructor(
    root: string,
    config: ProjectConfig,
    allowSensitive: boolean,
    fs: FsPort,
  ) {
    this.root = root;
    this.fs = fs;
    this.allowSensitive = allowSensitive;

    const rootResolved = fs.realpath(root) ?? fs.resolve(root);
    const allowed = [rootResolved];
    for (const extra of config.allowedRoots) {
      const resolved = fs.realpath(extra) ?? fs.resolve(extra);
      if (resolved !== null) {
        allowed.push(resolved);
      }
    }
    this.allowedRoots = allowed;

    const ignoreText = fs.readText(fs.join(root, IGNORE_FILE_NAME));
    const ignorePatterns = ignoreText !== null ? splitPatternLines(ignoreText) : [];
    this.ignoreMatcher = compileIgnorePatterns(ignorePatterns);

    this.sensitiveMatcher = compileIgnorePatterns([
      ...DEFAULT_SENSITIVE_PATTERNS,
      ...config.sensitivePaths,
    ]);
  }

  /**
   * Validate one repository-relative request path. Returns the resolved
   * absolute path on success, or a refusal reason without reading content.
   */
  guard(relPath: string): GuardResult {
    return this.check(relPath, false);
  }

  /**
   * Validate one repository-relative directory path (for `inspect` scopes).
   * Same rules as {@link guard}, but existing directories are accepted.
   */
  guardDir(relPath: string): GuardResult {
    return this.check(relPath, true);
  }

  /**
   * Validate one repository-relative write target. Writes stay inside the
   * repository root only (configured allowed roots stay read-only), never
   * touch `.ctx.toml`/`.ctxignore` (the permission-boundary files), and
   * honour the same ignore and sensitive rules as reads. The target may not
   * exist yet: the deepest existing ancestor is resolved and must stay inside
   * the root, so symlink escapes and broken links fail closed. Existing
   * directories are refused (files only).
   */
  guardWrite(relPath: string): GuardResult {
    const trimmed = relPath.trim();
    if (trimmed === "") {
      return { ok: false, kind: "refused", reason: "empty path" };
    }
    if (isAbsolutePath(trimmed)) {
      return {
        ok: false,
        kind: "refused",
        reason: "absolute paths are refused — use a repository-relative path",
      };
    }
    const segments = trimmed.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
    if (segments.some((s) => s === "..")) {
      return { ok: false, kind: "refused", reason: "path traversal is refused" };
    }
    if (segments.length === 0) {
      return { ok: false, kind: "refused", reason: "empty path" };
    }
    const rel = segments.join("/");
    if (rel === CONFIG_FILE_NAME || rel === IGNORE_FILE_NAME) {
      return {
        ok: false,
        kind: "refused",
        reason:
          `\`${rel}\` configures the context permission boundary — writes to it are refused`,
      };
    }
    const entry = this.entryAllowed(rel);
    if (!entry.ok) {
      return { ok: false, kind: "refused", reason: entry.reason };
    }

    const rootResolved = this.fs.realpath(this.root) ?? this.fs.resolve(this.root);
    const absPath = this.fs.join(this.root, ...segments);

    // Resolve the deepest existing ancestor and require it inside the
    // repository root; the (possibly empty) remaining tail is created.
    for (let i = segments.length; i >= 0; i--) {
      const probeRel = segments.slice(0, i).join("/");
      const probe = probeRel === "" ? this.root : this.fs.join(this.root, probeRel);
      if (!this.fs.exists(probe)) {
        continue;
      }
      const resolved = this.fs.realpath(probe);
      if (resolved === null) {
        return {
          ok: false,
          kind: "refused",
          reason: "write target cannot be resolved (broken symlink?)",
        };
      }
      if (!this.fs.isWithin(rootResolved, resolved)) {
        return {
          ok: false,
          kind: "refused",
          reason: "write target resolves outside the repository root",
        };
      }
      if (i === segments.length && this.fs.isDirectory(probe)) {
        return { ok: false, kind: "refused", reason: "is a directory — files only" };
      }
      break;
    }
    return { ok: true, kind: "ok", absPath, relPath: rel };
  }

  /**
   * Check whether a repository-relative path would be excluded by `.ctxignore`
   * or sensitive-path rules, without any filesystem access. Used by discovery
   * walks, which enumerate entries through the filesystem port themselves.
   */
  entryAllowed(relPath: string): { ok: true } | { ok: false; reason: string } {
    const rel = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const ignoredPattern = this.ignoreMatcher.match(rel);
    if (ignoredPattern !== null) {
      return {
        ok: false,
        reason: `excluded by .ctxignore pattern \`${ignoredPattern}\``,
      };
    }
    if (!this.allowSensitive) {
      const sensitivePattern = this.sensitiveMatcher.match(rel);
      if (sensitivePattern !== null) {
        return {
          ok: false,
          reason: "sensitive path — requires an explicit override to disclose",
        };
      }
    }
    return { ok: true };
  }

  /**
   * True when the fully resolved target of the absolute `absPath` lies inside
   * one of the allowed roots. Discovery walks validate every entry they
   * enumerate so symlinked directories (or files) escaping the repository or
   * configured allowed roots are skipped before their names can be disclosed.
   * Unresolvable (broken) entries fail closed.
   */
  resolvedWithinRoots(absPath: string): boolean {
    const resolved = this.fs.realpath(absPath);
    if (resolved === null) {
      return false;
    }
    return this.allowedRoots.some((allowed) => this.fs.isWithin(allowed, resolved));
  }

  private check(relPath: string, allowDir: boolean): GuardResult {
    const trimmed = relPath.trim();
    if (trimmed === "") {
      return { ok: false, kind: "refused", reason: "empty path" };
    }
    if (isAbsolutePath(trimmed)) {
      return {
        ok: false,
        kind: "refused",
        reason: "absolute paths are refused — use a repository-relative path",
      };
    }
    const segments = trimmed.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
    if (segments.some((s) => s === "..")) {
      return { ok: false, kind: "refused", reason: "path traversal is refused" };
    }
    if (segments.length === 0) {
      return { ok: false, kind: "refused", reason: "empty path" };
    }
    const rel = segments.join("/");

    const absPath = this.fs.join(this.root, ...segments);
    const resolved = this.fs.realpath(absPath);
    if (resolved === null) {
      return { ok: false, kind: "refused", reason: "not found in the repository" };
    }
    if (!this.allowedRoots.some((allowed) => this.fs.isWithin(allowed, resolved))) {
      return {
        ok: false,
        kind: "refused",
        reason: "path resolves outside the allowed roots (symlink escaping?)",
      };
    }
    if (this.fs.isDirectory(resolved) && !allowDir) {
      return { ok: false, kind: "refused", reason: "is a directory — files only" };
    }

    const entry = this.entryAllowed(rel);
    if (!entry.ok) {
      return { ok: false, kind: "refused", reason: entry.reason };
    }
    return { ok: true, kind: "ok", absPath: resolved, relPath: rel };
  }
}

/** Split ignore-file text into raw pattern lines. */
function splitPatternLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim());
}