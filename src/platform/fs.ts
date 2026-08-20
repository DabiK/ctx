/**
 * Filesystem port backed by Node's fs module, scoped to the paths handed to
 * the application use cases (no implicit traversal). Path containment and
 * symlink resolution semantics live here, not in application code.
 */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
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

  resolve(path: string): string {
    return resolve(path);
  }

  realpath(path: string): string | null {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  }

  isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  isWithin(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }
}