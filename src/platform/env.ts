/**
 * Environment port backed by the real process: platform detection and
 * PATH resolution for external executables (pbcopy, powershell.exe, rg).
 */

import { execFileSync } from "node:child_process";
import type { EnvPort } from "../application/ports.js";

/** Environment backed by the running Node process. */
export class SystemEnv implements EnvPort {
  readonly platform: NodeJS.Platform = process.platform;

  executableAvailable(name: string): boolean {
    try {
      // `where` on Windows, `which` on POSIX; both exit 0 when found.
      const lookup = this.platform === "win32" ? "where" : "which";
      execFileSync(lookup, [name], { stdio: "ignore", timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}
