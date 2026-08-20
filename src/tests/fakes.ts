/**
 * Fake platform ports for unit tests. Never touches a real clipboard,
 * filesystem, or Git executable.
 */

import type {
  ClipboardPort,
  EnvPort,
  FsPort,
  GitDiff,
  GitLogEntry,
  GitPatchResult,
  GitPort,
  GitShowResult,
  GitStatus,
  GitStatusFile,
  PlatformPorts,
  SearchMatch,
  SearchPort,
  TerminalPort,
} from "../application/ports.js";

export class FakeClipboard implements ClipboardPort {
  copied: string[] = [];
  failWith: Error | null = null;
  content = "";
  failReadWith: Error | null = null;

  async copy(text: string): Promise<void> {
    if (this.failWith !== null) {
      throw this.failWith;
    }
    this.copied.push(text);
  }

  async read(): Promise<string> {
    if (this.failReadWith !== null) {
      throw this.failReadWith;
    }
    return this.content;
  }

  lastCopied(): string | null {
    if (this.copied.length === 0) {
      return null;
    }
    return this.copied[this.copied.length - 1] ?? null;
  }
}

export class FakeTerminal implements TerminalPort {
  infoLines: string[] = [];
  errorLines: string[] = [];

  info(line: string): void {
    this.infoLines.push(line);
  }

  error(line: string): void {
    this.errorLines.push(line);
  }
}

export class FakeGit implements GitPort {
  /** Repository root to report for every query; `null` means "not a repo". */
  rootToReport: string | null = "/repo";

  /** Branch reported by `status` (null = detached HEAD). */
  branch: string | null = "main";
  /** Changed files reported by `status`. */
  statusFiles: GitStatusFile[] = [];
  /** Diff text and summary numbers reported by `diff`. */
  diffText = "";
  diffFiles = 0;
  diffInsertions = 0;
  diffDeletions = 0;
  /** Commits reported by `log`. */
  logEntries: GitLogEntry[] = [];
  /** `rev:path` → blob content reported by `show`. */
  showContents = new Map<string, string>();
  /** `rev:path` → git diagnostic reported by `show` for unknown objects. */
  showErrors = new Map<string, string>();
  /** When set, every port call throws (simulates a Git failure). */
  failWith: Error | null = null;
  /** When set, `checkPatch` returns this error (e.g. git apply --check failure). */
  checkError: string | null = null;
  /** When set, `applyPatch` returns this error (apply fails after preflight). */
  applyError: string | null = null;
  /** Patch text handed to `checkPatch`/`applyPatch` (for assertions). */
  lastCheckedPatch = "";
  lastAppliedPatch = "";

  lastDiffPath: string | null = null;
  lastDiffStaged = false;
  lastLogPath: string | null = null;
  lastLogLimit = 0;
  lastShowRev = "";
  lastShowPath = "";

  async root(_dir: string): Promise<string | null> {
    return this.rootToReport;
  }

  async status(_root: string): Promise<GitStatus> {
    if (this.failWith !== null) {
      throw this.failWith;
    }
    return { branch: this.branch, files: this.statusFiles };
  }

  async diff(_root: string, path: string | null, staged: boolean): Promise<GitDiff> {
    if (this.failWith !== null) {
      throw this.failWith;
    }
    this.lastDiffPath = path;
    this.lastDiffStaged = staged;
    return {
      text: this.diffText,
      files: this.diffFiles,
      insertions: this.diffInsertions,
      deletions: this.diffDeletions,
    };
  }

  async log(_root: string, path: string | null, limit: number): Promise<GitLogEntry[]> {
    if (this.failWith !== null) {
      throw this.failWith;
    }
    this.lastLogPath = path;
    this.lastLogLimit = limit;
    return this.logEntries.slice(0, limit);
  }

  async show(_root: string, rev: string, path: string): Promise<GitShowResult> {
    if (this.failWith !== null) {
      throw this.failWith;
    }
    this.lastShowRev = rev;
    this.lastShowPath = path;
    const key = `${rev}:${path}`;
    const error = this.showErrors.get(key);
    if (error !== undefined) {
      return { ok: false, error };
    }
    const content = this.showContents.get(key);
    if (content !== undefined) {
      return { ok: true, content };
    }
    return { ok: false, error: `fatal: path '${path}' does not exist in '${rev}'` };
  }

  async checkPatch(_root: string, patch: string): Promise<GitPatchResult> {
    if (this.failWith !== null) {
      throw this.failWith;
    }
    this.lastCheckedPatch = patch;
    return this.checkError === null ? { ok: true } : { ok: false, error: this.checkError };
  }

  async applyPatch(_root: string, patch: string): Promise<GitPatchResult> {
    if (this.failWith !== null) {
      throw this.failWith;
    }
    this.lastAppliedPatch = patch;
    return this.applyError === null ? { ok: true } : { ok: false, error: this.applyError };
  }
}

/** In-memory filesystem used by tests. */
export class FakeFs implements FsPort {
  cwdValue = "/repo";
  files = new Map<string, string>();
  /** Directories known to exist (the root always exists). */
  dirs = new Set<string>(["/"]);
  /** Symlinks: link path → resolved target path (POSIX-style). */
  symlinks = new Map<string, string>();

  cwd(): string {
    return this.cwdValue;
  }

  exists(path: string): boolean {
    // Like lstatSync, symlinks exist even before following them.
    return this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path);
  }

  readText(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  writeText(path: string, content: string): void {
    this.files.set(path, content);
  }

  mkdirs(path: string): boolean {
    this.dirs.add(path);
    this.seedDirsFor(path + "/placeholder");
    return true;
  }

  /**
   * POSIX-style path join kept deterministic across host platforms so tests
   * always address files with forward slashes.
   */
  join(...parts: string[]): string {
    return this.joinPosix(...parts);
  }

  resolve(path: string): string {
    return this.joinPosix(this.cwdValue, path);
  }

  realpath(path: string): string | null {
    const target = this.resolvePath(path);
    if (this.exists(target)) {
      return target;
    }
    return null;
  }

  isDirectory(path: string): boolean {
    // Like statSync, follow the symlink before testing the entry.
    return this.dirs.has(this.resolvePath(path));
  }

  readDir(path: string): string[] {
    // Like readdirSync on a symlinked directory, list the resolved target and
    // surface symlink entries (lstat shows them as names) alongside files.
    const target = this.resolvePath(path);
    const base = target === "/" ? "/" : target.replace(/\/$/, "") + "/";
    const names = new Set<string>();
    const addUnder = (key: string): void => {
      if (key.startsWith(base)) {
        const name = key.slice(base.length).split("/")[0];
        if (name !== undefined && name !== "") {
          names.add(name);
        }
      }
    };
    for (const key of this.files.keys()) addUnder(key);
    for (const key of this.dirs.keys()) addUnder(key);
    for (const key of this.symlinks.keys()) addUnder(key);
    return [...names];
  }

  isWithin(parent: string, child: string): boolean {
    const base = parent === "/" ? "/" : parent.replace(/\/$/, "");
    return child === base || child.startsWith(base + "/");
  }

  /** Convenience: seed a file (creating its parent directory). */
  seed(path: string, content: string): void {
    this.files.set(path, content);
    this.seedDirsFor(path);
  }

  /** Convenience: declare a directory. */
  seedDir(path: string): void {
    this.dirs.add(path);
    this.seedDirsFor(path + "/placeholder");
  }

  /** Convenience: register a symlink. */
  seedSymlink(linkPath: string, target: string): void {
    this.symlinks.set(linkPath, target);
  }

  private seedDirsFor(path: string): void {
    const segments = path.split("/").filter((s) => s.length > 0);
    let acc = "";
    for (const segment of segments.slice(0, -1)) {
      acc += "/" + segment;
      this.dirs.add(acc);
    }
  }

  /**
   * Fully resolve `path` through chained symlinks at every path component,
   * mirroring realpathSync semantics (POSIX-style paths).
   */
  private resolvePath(path: string): string {
    const isAbsolute = path.startsWith("/");
    const parts = path.split("/").filter((s) => s.length > 0);
    let current = isAbsolute ? "/" : "";
    let hops = 0;
    for (const part of parts) {
      const next = current === "/" || current === "" ? current + part : current + "/" + part;
      current = next;
      let resolved = this.symlinks.get(current);
      while (resolved !== undefined && hops < 16) {
        current = resolved;
        resolved = this.symlinks.get(current);
        hops++;
      }
    }
    return current;
  }

  private joinPosix(...parts: string[]): string {
    const nonEmpty = parts.filter((p) => p.length > 0);
    if (nonEmpty.length === 0) {
      return "";
    }
    const leading = (nonEmpty[0] ?? "").startsWith("/") ? "/" : "";
    const segments = nonEmpty.flatMap((p) => p.split(/[\\/]+/)).filter((s) => s.length > 0);
    return leading + segments.join("/");
  }
}

export class FakeEnv implements EnvPort {
  platform: NodeJS.Platform = "darwin";
  available = new Set<string>(["pbcopy", "rg"]);

  executableAvailable(name: string): boolean {
    return this.available.has(name);
  }
}

/** In-memory search backend used by tests. */
export class FakeSearch implements SearchPort {
  readonly name = "fake";
  matches: SearchMatch[] = [];
  failWith: Error | null = null;
  lastQuery = "";
  lastLimit = 0;

  async search(query: string, _roots: string[], limit: number): Promise<SearchMatch[]> {
    if (this.failWith !== null) {
      throw this.failWith;
    }
    this.lastQuery = query;
    this.lastLimit = limit;
    return this.matches.slice(0, limit);
  }
}

/** Build a full fake port bundle with defaults. */
export function fakePorts(overrides: Partial<{
  clipboard: FakeClipboard;
  terminal: FakeTerminal;
  git: FakeGit;
  fs: FakeFs;
  env: FakeEnv;
  search: FakeSearch;
}> = {}): {
  ports: PlatformPorts;
  clipboard: FakeClipboard;
  terminal: FakeTerminal;
  git: FakeGit;
  fs: FakeFs;
  env: FakeEnv;
  search: FakeSearch;
} {
  const clipboard = overrides.clipboard ?? new FakeClipboard();
  const terminal = overrides.terminal ?? new FakeTerminal();
  const git = overrides.git ?? new FakeGit();
  const fs = overrides.fs ?? new FakeFs();
  const env = overrides.env ?? new FakeEnv();
  const search = overrides.search ?? new FakeSearch();
  return {
    ports: { clipboard, terminal, git, fs, env, search },
    clipboard,
    terminal,
    git,
    fs,
    env,
    search,
  };
}
