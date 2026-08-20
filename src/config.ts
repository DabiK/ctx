/**
 * Project configuration (`.ctx.toml`) parsing (pure domain logic).
 *
 * A deliberately small line-based reader for the keys ctx uses: `allowed_roots`
 * (absolute external roots ctx may read), `line_numbers` (line numbering for
 * copied content, default true), `sensitive_paths` (explicit sensitive paths
 * in addition to the built-in defaults), and the discovery limits
 * `tree_depth`, `inspect_depth`, and `max_results`. Anything unrecognized or
 * malformed keeps the default; `ctx doctor` is the diagnostic surface.
 */

/** Hard cap on tree/inspect depth so a misconfigured project stays bounded. */
export const MAX_DEPTH = 10;
/** Hard cap on per-operation result counts so a misconfigured project stays bounded. */
export const MAX_RESULTS = 1000;
/** Hard cap on the per-file read budget so a misconfigured project stays bounded. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Hard cap on the total-response budget so a misconfigured project stays bounded. */
export const MAX_BATCH_BYTES = 128 * 1024 * 1024;

export interface ProjectConfig {
  /** Absolute directories ctx may read in addition to the repository root. */
  allowedRoots: string[];
  /** Prefix copied file lines with numbers (true by default). */
  lineNumbers: boolean;
  /** Sensitive path patterns in addition to the built-in defaults. */
  sensitivePaths: string[];
  /** Default depth of `ctx tree` (clamped to [1, MAX_DEPTH]). */
  treeDepth: number;
  /** Default depth of `ctx inspect` (clamped to [1, MAX_DEPTH]). */
  inspectDepth: number;
  /** Default per-operation result limit (clamped to [1, MAX_RESULTS]). */
  maxResults: number;
  /**
   * Per-file content budget in bytes: a read whose selected content exceeds
   * this is omitted (never silently truncated) before the context is copied.
   * Clamped to [1, MAX_FILE_BYTES].
   */
  maxFileBytes: number;
  /**
   * Total-response budget in bytes: a request whose copied response exceeds
   * this fails closed and copies a recovery response instead. Clamped to
   * [1, MAX_BATCH_BYTES].
   */
  maxBatchBytes: number;
}

export const DEFAULT_CONFIG: ProjectConfig = {
  allowedRoots: [],
  lineNumbers: true,
  sensitivePaths: [],
  treeDepth: 3,
  inspectDepth: 2,
  maxResults: 100,
  maxFileBytes: 256 * 1024,
  maxBatchBytes: 1024 * 1024,
};

/** Parse `.ctx.toml` text; `null` (missing file) yields the defaults. */
export function parseProjectConfig(text: string | null): ProjectConfig {
  const config: ProjectConfig = {
    allowedRoots: [...DEFAULT_CONFIG.allowedRoots],
    lineNumbers: DEFAULT_CONFIG.lineNumbers,
    sensitivePaths: [...DEFAULT_CONFIG.sensitivePaths],
    treeDepth: DEFAULT_CONFIG.treeDepth,
    inspectDepth: DEFAULT_CONFIG.inspectDepth,
    maxResults: DEFAULT_CONFIG.maxResults,
    maxFileBytes: DEFAULT_CONFIG.maxFileBytes,
    maxBatchBytes: DEFAULT_CONFIG.maxBatchBytes,
  };
  if (text === null) {
    return config;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "allowed_roots") {
      const parsed = parseStringArray(value);
      if (parsed !== null) {
        config.allowedRoots = parsed;
      }
    } else if (key === "sensitive_paths") {
      const parsed = parseStringArray(value);
      if (parsed !== null) {
        config.sensitivePaths = parsed;
      }
    } else if (key === "line_numbers") {
      const parsed = parseBool(value);
      if (parsed !== null) {
        config.lineNumbers = parsed;
      }
    } else if (key === "tree_depth") {
      const parsed = parsePositiveInt(value);
      if (parsed !== null) {
        config.treeDepth = parsed;
      }
    } else if (key === "inspect_depth") {
      const parsed = parsePositiveInt(value);
      if (parsed !== null) {
        config.inspectDepth = parsed;
      }
    } else if (key === "max_results") {
      const parsed = parsePositiveInt(value);
      if (parsed !== null) {
        config.maxResults = parsed;
      }
    } else if (key === "max_file_bytes") {
      const parsed = parsePositiveInt(value);
      if (parsed !== null) {
        config.maxFileBytes = parsed;
      }
    } else if (key === "max_batch_bytes") {
      const parsed = parsePositiveInt(value);
      if (parsed !== null) {
        config.maxBatchBytes = parsed;
      }
    }
  }
  return config;
}

/** Parse `["a", "b"]` into strings, or `null` when malformed. */
function parseStringArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }
  const items: string[] = [];
  for (const rawItem of inner.split(",")) {
    const item = rawItem.trim();
    if (item.length < 2) {
      return null;
    }
    const quote = item[0];
    if ((quote !== '"' && quote !== "'") || item[item.length - 1] !== quote) {
      return null;
    }
    items.push(item.slice(1, -1));
  }
  return items;
}

/** Parse `true`/`false`, or `null` when malformed. */
function parseBool(value: string): boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

/** Parse a positive integer, or `null` when malformed. */
function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Clamp a per-file budget to [1, MAX_FILE_BYTES] so a misconfigured project stays bounded. */
export function clampFileBytes(n: number): number {
  return Math.min(Math.max(1, Math.floor(n)), MAX_FILE_BYTES);
}

/** Clamp a total-response budget to [1, MAX_BATCH_BYTES] so a misconfigured project stays bounded. */
export function clampBatchBytes(n: number): number {
  return Math.min(Math.max(1, Math.floor(n)), MAX_BATCH_BYTES);
}
