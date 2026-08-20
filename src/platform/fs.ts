/**
 * Filesystem port backed by Node's fs module, scoped to the paths handed to
 * the application service (no implicit traversal).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FsPort } from "../application/ports.js";

/** Filesystem backed by node:fs. */
export class SystemFs implements FsPort {
  cwd(): string {
    return process.cwd();
  }

  exists(path: string): boolean {
    return existsSync(path);
  }

  readText(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  writeText(path: string, content: string): void {
    writeFileSync(path, content, "utf8");
  }

  join(...parts: string[]): string {
    return join(...parts);
  }
}
