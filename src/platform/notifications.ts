/**
 * Optional desktop notification adapter for `ctx watch`. On macOS it drives
 * `osascript display notification`; on Windows it uses a PowerShell WinForms
 * balloon. Notifications are strictly optional and fire-and-forget: an
 * unavailable backend or a failing command never crashes or blocks the
 * watcher, and unsupported platforms simply do nothing.
 */

import { spawn } from "node:child_process";
import type { NotificationPort } from "../application/ports.js";

/** Desktop notifications backed by the OS-native scripting bridge. */
export class SystemNotifications implements NotificationPort {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  notify(title: string, body: string): void {
    const command = this.commandArgs(title, body);
    if (command === null) {
      return;
    }
    const child = spawn(command[0], command[1], { stdio: "ignore" });
    // Notifications are optional: a failing backend never crashes the watcher.
    child.on("error", () => {});
  }

  /** The [executable, argv] pair for this platform, or null when unsupported. */
  private commandArgs(title: string, body: string): [string, string[]] | null {
    if (this.platform === "darwin") {
      // osascript's display notification uses double quotes; soften any inner
      // quotes so the AppleScript command stays well-formed.
      const t = title.replace(/"/g, "'");
      const b = body.replace(/"/g, "'");
      return ["osascript", ["-e", `display notification "${b}" with title "${t}"`]];
    }
    if (this.platform === "win32") {
      // PowerShell single-quoted strings escape an embedded quote by doubling.
      const t = title.replace(/'/g, "''");
      const b = body.replace(/'/g, "''");
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$n = New-Object System.Windows.Forms.NotifyIcon",
        "$n.Icon = [System.Drawing.SystemIcons]::Information",
        `$n.BalloonTipTitle = '${t}'`,
        `$n.BalloonTipText = '${b}'`,
        "$n.Visible = $true",
        "$n.ShowBalloonTip(5000)",
      ].join("; ");
      return [
        "powershell",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      ];
    }
    return null;
  }
}