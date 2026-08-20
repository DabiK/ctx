/**
 * Application ports: owned by the application layer, implemented by outbound
 * infrastructure adapters (see ../platform). Application use cases depend
 * only on these interfaces; tests inject fakes instead of the real platform.
 */

/** Clipboard transport: the single channel between ctx and the LLM chat. */
export interface ClipboardPort {
  /** Copy `text` to the system clipboard. Rejects when unsupported. */
  copy(text: string): Promise<void>;
}

/** Terminal output. Direct commands print concise output here. */
export interface TerminalPort {
  /** Ordinary status/info line. */
  info(line: string): void;
  /** Error/diagnostic line. */
  error(line: string): void;
}

/**
 * Git operations. ctx requires a Git repository; repository root discovery is
 * a core boundary and Git features are never silently simulated.
 */
export interface GitPort {
  /**
   * Resolve the repository root that contains `dir`, or `null` when `dir` is
   * not inside a Git repository (or Git is unavailable).
   */
  root(dir: string): Promise<string | null>;
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
   * Join path segments with the platform separator. Platform path semantics
   * belong to the filesystem adapter, not to application code.
   */
  join(...parts: string[]): string;
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
}
