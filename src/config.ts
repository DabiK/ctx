/**
 * Project configuration (`.ctx.toml`) parsing (pure domain logic).
 *
 * A deliberately small line-based reader for the keys ctx uses: `allowed_roots`
 * (absolute external roots ctx may read), `line_numbers` (line numbering for
 * copied content, default true), and `sensitive_paths` (explicit sensitive
 * paths in addition to the built-in defaults). Anything unrecognized or
 * malformed keeps the default; `ctx doctor` is the diagnostic surface.
 */

export interface ProjectConfig {
  /** Absolute directories ctx may read in addition to the repository root. */
  allowedRoots: string[];
  /** Prefix copied file lines with numbers (true by default). */
  lineNumbers: boolean;
  /** Sensitive path patterns in addition to the built-in defaults. */
  sensitivePaths: string[];
}

export const DEFAULT_CONFIG: ProjectConfig = {
  allowedRoots: [],
  lineNumbers: true,
  sensitivePaths: [],
};

/** Parse `.ctx.toml` text; `null` (missing file) yields the defaults. */
export function parseProjectConfig(text: string | null): ProjectConfig {
  const config: ProjectConfig = {
    allowedRoots: [...DEFAULT_CONFIG.allowedRoots],
    lineNumbers: DEFAULT_CONFIG.lineNumbers,
    sensitivePaths: [...DEFAULT_CONFIG.sensitivePaths],
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
