/**
 * Application ports: owned by the application layer, implemented by outbound
 * infrastructure adapters (see ../platform). Application use cases depend
 * only on these interfaces; tests inject fakes instead of the real platform.
 */

/** Clipboard transport: the single channel between ctx and the LLM chat. */
export interface ClipboardPort {
  /** Copy `text` to the system clipboard. Rejects when unsupported. */
  copy(text: string): Promise<void>;
  /** Read the current clipboard content. Rejects when unsupported. */
  read(): Promise<string>;
}

/** Terminal output. Direct commands print concise output here. */
export interface TerminalPort {
  /** Ordinary status/info line. */
  info(line: string): void;
  /** Error/diagnostic line. */
  error(line: string): void;
}

/** State bucket of one changed file reported by `git status`. */
export type GitFileState = "staged" | "modified" | "untracked" | "deleted";

/** One changed file in a repository status. */
export interface GitStatusFile {
  /** Repository-relative path with forward slashes. */
  relPath: string;
  state: GitFileState;
}

/** Parsed `git status --porcelain=v1 -b` result. */
export interface GitStatus {
  /** Current branch name, or `null` on a detached HEAD. */
  branch: string | null;
  files: GitStatusFile[];
}

/** One recent commit entry from `git log`. */
export interface GitLogEntry {
  /** Short (7-char) commit hash. */
  shortHash: string;
  /** Commit date in YYYY-MM-DD form. */
  date: string;
  /** First line of the commit message. */
  subject: string;
}

/** Parsed `git diff` output with summary numbers (binary entries excluded). */
export interface GitDiff {
  /** The diff text itself. */
  text: string;
  /** Number of files touched by the diff. */
  files: number;
  /** Total added lines. */
  insertions: number;
  /** Total deleted lines. */
  deletions: number;
}

/** Result of `git show <rev>:<path>` — a blob read from the object store. */
export type GitShowResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/** Result of a `git apply` preflight or application. */
export type GitPatchResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Git operations. ctx requires a Git repository; repository root discovery is
 * a core boundary and Git features are never silently simulated. The port
 * surface is the fixed allowlist of Git behavior: every method maps to one
 * well-defined `git` invocation (or its Windows-native equivalent);
 * nothing here is arbitrary Git or shell execution.
 */
export interface GitPort {
  /**
   * Resolve the repository root that contains `dir`, or `null` when `dir` is
   * not inside a Git repository (or Git is unavailable).
   */
  root(dir: string): Promise<string | null>;
  /** Parsed `git status --porcelain=v1 -b` for `root`. */
  status(root: string): Promise<GitStatus>;
  /**
   * `git diff` output for `root`, optionally scoped to a validated repository
   * `path` (`null` = whole working tree). `staged` selects the staged diff.
   */
  diff(root: string, path: string | null, staged: boolean): Promise<GitDiff>;
  /** Up to `limit` recent commits of `root`, optionally scoped to `path`. */
  log(root: string, path: string | null, limit: number): Promise<GitLogEntry[]>;
  /**
   * Content of `path` at revision `rev`, read from the object store. Fails
   * (with the Git diagnostic) when the revision or path does not exist there.
   */
  show(root: string, rev: string, path: string): Promise<GitShowResult>;
  /**
   * `git apply --check` — verify `patch` applies cleanly to the working tree
   * of `root` without changing anything. The application layer preflights
   * every tagged patch before any file change.
   */
  checkPatch(root: string, patch: string): Promise<GitPatchResult>;
  /**
   * `git apply` — apply `patch` to the working tree of `root`. Git is the
   * recovery path (`git apply -R` reverses the change). A non-zero exit
   * carries the Git diagnostic.
   */
  applyPatch(root: string, patch: string): Promise<GitPatchResult>;
}

/** Narrow filesystem surface used by the application use cases. */
export interface FsPort {
  /** Current working directory of the process. */
  cwd(): string;
  /** True when a file exists at `path`. */
  exists(path: string): boolean;
  /** File content, or `null` when missing/unreadable. */
  readText(path: string): string | null;
  /** Write `content` to `path` (creates or replaces). */
  writeText(path: string, content: string): void;
  /**
   * Create `path` and any missing parent directories. Returns `true` when the
   * directory exists afterwards; `false` when it could not be created.
   */
  mkdirs(path: string): boolean;
  /**
   * Join path segments with the platform separator. Platform path semantics
   * belong to the filesystem adapter, not to application code.
   */
  join(...parts: string[]): string;
  /** Absolute normalized path of `path` without resolving symlinks. */
  resolve(path: string): string;
  /**
   * Resolve symlinks on `path` (the fully resolved target), or `null` when
   * the path does not exist or cannot be resolved. The resolved target is
   * used to enforce the allowed-root boundary.
   */
  realpath(path: string): string | null;
  /** True when `path` is an existing directory. */
  isDirectory(path: string): boolean;
  /** Names of the entries directly under `path`, or `[]` when missing/unreadable. */
  readDir(path: string): string[];
  /**
   * True when `child` is `parent` itself or located under it. Both paths are
   * expected to be absolute; platform containment semantics live here.
   */
  isWithin(parent: string, child: string): boolean;
}

/** One raw content-search match (path, line, and matched line content). */
export interface SearchMatch {
  /** Repository-relative path with forward slashes. */
  relPath: string;
  /** 1-based line number of the match. */
  line: number;
  /** The matched line content, without a trailing newline. */
  content: string;
}

/**
 * Content search backend. ripgrep is the preferred implementation; findstr is
 * the Windows-native fallback. Backends return raw matches; ignore, allowed
 * root, and sensitive rules are applied uniformly by the application use case
 * so both backends obey the same contract.
 */
export interface SearchPort {
  /** Backend name used in response metadata ("ripgrep" | "findstr"). */
  readonly name: string;
  /**
   * Search `roots` (absolute directories) for `query`, returning at most
   * `limit` raw matches. `relPath` of every match is relative to the first
   * root. Rejects when the backend cannot run; a "no matches" exit is an
   * empty result, not an error.
   */
  search(query: string, roots: string[], limit: number): Promise<SearchMatch[]>;
}

/** Environment/OS capabilities. */
export interface EnvPort {
  /** Host platform as reported by Node (`darwin`, `win32`, ...). */
  platform: NodeJS.Platform;
  /** True when an executable is resolvable on PATH. */
  executableAvailable(name: string): boolean;
}

/** Bundled ports wired by the CLI inbound adapter. */
export interface PlatformPorts {
  clipboard: ClipboardPort;
  terminal: TerminalPort;
  git: GitPort;
  fs: FsPort;
  env: EnvPort;
  search: SearchPort;
}
