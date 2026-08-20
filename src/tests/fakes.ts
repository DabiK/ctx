/**
 * Fake platform ports for unit tests. Never touches a real clipboard,
 * filesystem, or Git executable.
 */

import type {
  ClipboardPort,
  EnvPort,
  FsPort,
  GitPort,
  PlatformPorts,
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

  async root(_dir: string): Promise<string | null> {
    return this.rootToReport;
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
    return this.files.has(path) || this.dirs.has(path);
  }

  readText(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  writeText(path: string, content: string): void {
    this.files.set(path, content);
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
    const direct = this.symlinks.get(path);
    const target = direct ?? path;
    if (this.exists(target)) {
      return target;
    }
    return null;
  }

  isDirectory(path: string): boolean {
    return this.dirs.has(path);
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

/** Build a full fake port bundle with defaults. */
export function fakePorts(overrides: Partial<{
  clipboard: FakeClipboard;
  terminal: FakeTerminal;
  git: FakeGit;
  fs: FakeFs;
  env: FakeEnv;
}> = {}): {
  ports: PlatformPorts;
  clipboard: FakeClipboard;
  terminal: FakeTerminal;
  git: FakeGit;
  fs: FakeFs;
  env: FakeEnv;
} {
  const clipboard = overrides.clipboard ?? new FakeClipboard();
  const terminal = overrides.terminal ?? new FakeTerminal();
  const git = overrides.git ?? new FakeGit();
  const fs = overrides.fs ?? new FakeFs();
  const env = overrides.env ?? new FakeEnv();
  return {
    ports: { clipboard, terminal, git, fs, env },
    clipboard,
    terminal,
    git,
    fs,
    env,
  };
}
