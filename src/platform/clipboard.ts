/**
 * Real clipboard adapter for macOS and Windows.
 *
 * macOS uses `pbcopy`. Windows uses PowerShell `Set-Clipboard`. Other
 * platforms are outside the MVP and reject with an actionable error.
 */

import { spawn } from "node:child_process";
import type { ClipboardPort, EnvPort } from "../application/ports.js";

/** Write `input` to the stdin of a spawned process and await its exit. */
function writeStdin(file: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(stderr.trim() || `${file} exited with code ${code}`),
        );
      }
    });
    child.stdin.on("error", () => {
      /* stdin may be closed early on failure; the close handler reports it. */
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

/** Clipboard that writes through the platform-native tool. */
export class SystemClipboard implements ClipboardPort {
  constructor(private readonly env: EnvPort) {}

  async copy(text: string): Promise<void> {
    const { platform } = this.env;
    if (platform === "darwin") {
      await writeStdin("pbcopy", [], text);
      return;
    }
    if (platform === "win32") {
      await writeStdin(
        "powershell.exe",
        ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
        text,
      );
      return;
    }
    throw new Error(
      `Clipboard is not supported on this platform (${platform}). ` +
        `ctx supports macOS and Windows in the MVP.`,
    );
  }
}

/** Resolve the clipboard implementation for the current platform. */
export function platformClipboard(env: EnvPort): ClipboardPort {
  return new SystemClipboard(env);
}
