/**
 * User-local configuration adapter: the watcher mode persisted outside the
 * repository. On macOS/Linux this is `~/.config/ctx/config.json`; on Windows
 * `%APPDATA%\ctx\config.json` (falling back to `AppData\Roaming` under the
 * home directory). The project never stores this personal preference, so
 * collaborators do not inherit an automation mode through repository files.
 *
 * Persistence is best-effort: a missing, unreadable, or malformed file yields
 * `null` (the application default applies) and write failures never crash the
 * watcher.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UserConfigPort, WatchMode } from "../application/ports.js";

/** The watcher modes a persisted value may carry. */
const VALID_MODES: readonly WatchMode[] = ["safe", "auto", "yolo"];

/** User-local config backed by a JSON file in the user's config directory. */
export class SystemUserConfig implements UserConfigPort {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  readMode(): WatchMode | null {
    try {
      const raw = readFileSync(this.configFile(), "utf8");
      const parsed = JSON.parse(raw) as { mode?: unknown };
      if (
        typeof parsed.mode === "string" &&
        (VALID_MODES as readonly string[]).includes(parsed.mode)
      ) {
        return parsed.mode as WatchMode;
      }
    } catch {
      /* missing, unreadable, or malformed config → no persisted mode */
    }
    return null;
  }

  writeMode(mode: WatchMode): void {
    try {
      const file = this.configFile();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ mode }, null, 2) + "\n", "utf8");
    } catch {
      /* persistence is best-effort; the session keeps the selected mode */
    }
  }

  private configFile(): string {
    const home = homedir();
    if (this.platform === "win32") {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "ctx", "config.json");
    }
    return join(home, ".config", "ctx", "config.json");
  }
}