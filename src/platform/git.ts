/**
 * Real Git port. Repository root discovery via `git rev-parse
 * --show-toplevel` — the core permission boundary for ctx.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitPort } from "../application/ports.js";

const execFileAsync = promisify(execFile);

/** Git port backed by the git executable on PATH. */
export class SystemGit implements GitPort {
  async root(dir: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd: dir, timeout: 10_000 },
      );
      const root = stdout.trim();
      return root.length > 0 ? root : null;
    } catch {
      // Not a repository, or Git is unavailable. Both are "no root".
      return null;
    }
  }
}
