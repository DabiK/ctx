/**
 * Real Git port (outbound adapter).
 *
 * Repository root discovery via `git rev-parse --show-toplevel` — the core
 * permission boundary for ctx — plus the fixed allowlist of read-only context
 * operations: `status`, `diff`, `log`, and `show`. Every method maps to one
 * well-defined `git` invocation with a static argument list; values from the
 * application layer (validated paths, safe revisions, limits) are passed as
 * separate argv elements, never through a shell. Output parsers are pure
 * functions so they stay unit-testable on any host.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type {
  GitDiff,
  GitFileState,
  GitLogEntry,
  GitPatchResult,
  GitPort,
  GitShowResult,
  GitStatus,
  GitStatusFile,
} from "../application/ports.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT = 15_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/** Git port backed by the git executable on PATH. */
export class SystemGit implements GitPort {
  async root(dir: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd: dir, timeout: GIT_TIMEOUT },
      );
      const root = stdout.trim();
      return root.length > 0 ? root : null;
    } catch {
      // Not a repository, or Git is unavailable. Both are "no root".
      return null;
    }
  }

  /** `git status --porcelain=v1 -b`, parsed into branch and file buckets. */
  async status(root: string): Promise<GitStatus> {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-b", "--untracked-files=normal"],
      { cwd: root, timeout: GIT_TIMEOUT, maxBuffer: MAX_BUFFER },
    );
    return parsePorcelainV1(stdout);
  }

  /**
   * `git diff` (working tree or `--staged`), optionally scoped to a validated
   * repository path. Runs the summary and the full text in parallel; the
   * summary numbers come from `--numstat` (binary entries counted but not
   * summed).
   */
  async diff(root: string, path: string | null, staged: boolean): Promise<GitDiff> {
    const scopeArgs = path === null ? [] : ["--", literalPath(path)];
    const stagedArgs = staged ? ["--staged"] : [];
    const [{ stdout: numstat }, { stdout: text }] = await Promise.all([
      execFileAsync("git", ["diff", "--numstat", ...stagedArgs, ...scopeArgs], {
        cwd: root,
        timeout: GIT_TIMEOUT,
        maxBuffer: MAX_BUFFER,
      }),
      execFileAsync("git", ["diff", ...stagedArgs, ...scopeArgs], {
        cwd: root,
        timeout: GIT_TIMEOUT,
        maxBuffer: MAX_BUFFER,
      }),
    ]);
    const summary = parseNumstat(numstat);
    return { text, ...summary };
  }

  /** `git log` bounded to `limit` commits, optionally scoped to a path. */
  async log(root: string, path: string | null, limit: number): Promise<GitLogEntry[]> {
    const args = ["log", "-n", String(limit), "--date=short", "--format=%h%x1f%ad%x1f%s"];
    if (path !== null) {
      args.push("--", literalPath(path));
    }
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: root,
        timeout: GIT_TIMEOUT,
        maxBuffer: MAX_BUFFER,
      });
      return parseLogOutput(stdout);
    } catch (err) {
      // A repository with no commits is an empty state, not a failure.
      if (isEmptyLogError(err)) {
        return [];
      }
      throw err;
    }
  }

  /** `git show <rev>:<path>` — one blob read from the object store. */
  async show(root: string, rev: string, path: string): Promise<GitShowResult> {
    try {
      const { stdout } = await execFileAsync("git", ["show", `${rev}:${path}`], {
        cwd: root,
        timeout: GIT_TIMEOUT,
        maxBuffer: MAX_BUFFER,
      });
      return { ok: true, content: stdout.replace(/\r?\n$/, "") };
    } catch (err) {
      return { ok: false, error: stderrOf(err) ?? "git show failed" };
    }
  }

  /** `git apply --check` — verify the patch applies without changing anything. */
  async checkPatch(root: string, patch: string): Promise<GitPatchResult> {
    const result = await this.gitWithStdin(["apply", "--check", "-"], root, patch);
    if (result.code === 0) {
      return { ok: true };
    }
    return { ok: false, error: trimStderr(result.stderr) ?? "git apply --check failed" };
  }

  /** `git apply` — apply the patch to the working tree (Git is the recovery path). */
  async applyPatch(root: string, patch: string): Promise<GitPatchResult> {
    const result = await this.gitWithStdin(["apply", "-"], root, patch);
    if (result.code === 0) {
      return { ok: true };
    }
    return { ok: false, error: trimStderr(result.stderr) ?? "git apply failed" };
  }

  /**
   * Run `git` with `input` on stdin (used by the patch operations; the patch
   * is never written to disk). Returns the exit code and captured output.
   */
  private async gitWithStdin(
    args: string[],
    cwd: string,
    input: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`git ${args[0]} timed out`));
      }, GIT_TIMEOUT);
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        }
      });
      child.stdin.on("error", () => {
        // Git may exit before stdin closes; the close event carries the result.
      });
      child.stdin.end(input);
    });
  }
}

/**
 * Parse `git status --porcelain=v1 -b` output into a branch and per-file
 * state buckets (pure, exported for tests). Each file lands in exactly one
 * bucket; staged-deletion and worktree-deletion both count as "deleted".
 */
export function parsePorcelainV1(stdout: string): GitStatus {
  const files: GitStatusFile[] = [];
  let branch: string | null = null;

  for (const raw of stdout.split(/\r?\n/)) {
    if (raw === "") {
      continue;
    }
    if (raw.startsWith("## ")) {
      const rest = raw.slice(3);
      if (rest.startsWith("HEAD")) {
        // Detached HEAD: `## HEAD (no branch)`.
        branch = null;
        continue;
      }
      if (rest.startsWith("No commits yet on ")) {
        branch = cleanBranch(rest.slice(18));
        continue;
      }
      if (rest.startsWith("Initial commit on ")) {
        branch = cleanBranch(rest.slice(18));
        continue;
      }
      // `## main...origin/main [ahead 1]` — the branch precedes `...`.
      branch = cleanBranch(rest.split("...")[0] ?? rest);
      continue;
    }
    if (raw.length < 4) {
      continue;
    }
    const x = raw[0] ?? " ";
    const y = raw[1] ?? " ";
    let relPath = raw.slice(3);
    // Rename/copy entries report `new -> old`; keep the destination path.
    if (x === "R" || x === "C") {
      const arrow = relPath.indexOf(" -> ");
      if (arrow >= 0) {
        relPath = relPath.slice(arrow + 4);
      }
    }
    let state: GitFileState;
    if (x === "?" && y === "?") {
      state = "untracked";
    } else if (x === "D" || y === "D") {
      state = "deleted";
    } else if (x !== " " && x !== "?") {
      state = "staged";
    } else {
      state = "modified";
    }
    files.push({ relPath, state });
  }

  return { branch, files };
}

/** Strip upstream and ahead/behind markers from a porcelain branch name. */
function cleanBranch(branch: string): string {
  return branch.split(" ")[0] ?? "";
}

/**
 * Parse `git diff --numstat` output into summary numbers (pure, exported for
 * tests). `-` counts (binary files) contribute to the file count only.
 */
export function parseNumstat(stdout: string): {
  files: number;
  insertions: number;
  deletions: number;
} {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw === "") {
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(raw);
    if (match === null) {
      continue;
    }
    files++;
    if ((match[1] ?? "") !== "-") {
      insertions += Number(match[1]);
    }
    if ((match[2] ?? "") !== "-") {
      deletions += Number(match[2]);
    }
  }
  return { files, insertions, deletions };
}

/** Parse `git log --format=%h%x1f%ad%x1f%s` output into entries (pure). */
export function parseLogOutput(stdout: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw === "") {
      continue;
    }
    const parts = raw.split("\u001f");
    const shortHash = parts[0] ?? "";
    if (shortHash === "") {
      continue;
    }
    entries.push({
      shortHash,
      date: parts[1] ?? "",
      subject: parts.slice(2).join("\u001f"),
    });
  }
  return entries;
}

/**
 * Pathspec for a validated repository-relative path. `:(literal)` disables
 * glob/magic interpretation so a path is always matched as itself.
 */
function literalPath(path: string): string {
  return `:(literal)${path}`;
}

/** The `git log` "does not have any commits yet" exit (128) with its message. */
function isEmptyLogError(err: unknown): boolean {
  return (stderrOf(err) ?? "").includes("does not have any commits");
}

/** Trimmed stderr of an execFile error, or `null` when absent. */
function stderrOf(err: unknown): string | null {
  if (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { stderr?: unknown }).stderr === "string"
  ) {
    const text = (err as { stderr: string }).stderr.trim();
    return text === "" ? null : text;
  }
  return null;
}

/** Trimmed non-empty stderr text, or `null`. */
function trimStderr(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}