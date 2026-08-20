/**
 * Git-style context-ignore matching (pure domain logic).
 *
 * Used for both `.ctxignore` exclusions and sensitive-path patterns. Kept
 * deliberately small: comments, blank lines, `!` negation, trailing-`/`
 * directory patterns, `*`, `?`, and `**` globs, at any depth unless the
 * pattern contains a slash. Last matching pattern wins, as in gitignore.
 */

export interface CompiledIgnore {
  /** The matching pattern that excludes `relPath`, or `null` when allowed. */
  match(relPath: string): string | null;
}

/**
 * Compile ignore patterns (raw lines, as found in `.ctxignore` or the
 * configured sensitive-path list) into a matcher.
 */
export function compileIgnorePatterns(lines: string[]): CompiledIgnore {
  const entries: { pattern: string; negate: boolean; regex: RegExp }[] = [];
  for (const raw of lines) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
      if (line === "") {
        continue;
      }
    }
    entries.push({ pattern: raw.trim(), negate, regex: buildPatternRegex(line) });
  }
  return {
    match(relPath: string): string | null {
      const normalized = relPath.replace(/\\/g, "/");
      let ignored = false;
      let reason: string | null = null;
      for (const entry of entries) {
        if (entry.regex.test(normalized)) {
          ignored = !entry.negate;
          if (!entry.negate) {
            reason = entry.pattern;
          }
        }
      }
      return ignored ? (reason ?? "ignored") : null;
    },
  };
}

/** Build the anchored regex for one non-negated pattern line. */
function buildPatternRegex(pattern: string): RegExp {
  const isDirPattern = pattern.endsWith("/");
  const stripped = isDirPattern ? pattern.slice(0, -1) : pattern;
  const containsSlash = stripped.includes("/");
  const leadingDoubleStar = stripped.startsWith("**/");

  let source = "";
  if (leadingDoubleStar) {
    source = "(?:.*/)?";
    source += globToRegexSource(stripped.slice(3));
  } else {
    source = globToRegexSource(stripped);
  }
  if (!containsSlash && !leadingDoubleStar) {
    // A pattern without a slash matches the basename at any depth.
    source = "(?:.*/)?" + source;
  }
  if (isDirPattern) {
    // Matches the directory itself and everything under it.
    source += "(?:/.*)?";
  }
  return new RegExp("^" + source + "$");
}

/** Convert `*`, `?`, and `**` glob syntax to a regex source fragment. */
export function globToRegexSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      if ((pattern[i + 1] ?? "") === "*") {
        out += ".*";
        i += 2;
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if ("\\^$.+()[]{}|".includes(ch)) {
      out += "\\" + ch;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}
