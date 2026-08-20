/**
 * Real foreground TUI adapter for `ctx watch` (macOS and Windows terminals).
 *
 * Renders the watcher view with ANSI escape sequences and reads keyboard
 * input through `process.stdin` in raw mode. Modern macOS and Windows 10+
 * terminals support VT sequences; no external dependencies are used. The
 * application watcher drives all interaction through the {@link TuiPort}
 * contract, so this adapter stays thin and the testable logic lives in the
 * application layer.
 */

import type { TuiPort, WatcherView } from "../application/ports.js";

const ESC = "\u001b";

/** ANSI: clear screen and home the cursor, hide/show cursor, clear line. */
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `${ESC}[2K\r`;

/** Truncate long text for the compact view (keeps full content in detail). */
function truncate(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`].join("\n");
}

export class SystemTui implements TuiPort {
  private raw = false;

  open(): void {
    const stdin = process.stdin;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding("utf8");
    this.raw = true;
    process.stdout.write(HIDE_CURSOR);
  }

  render(view: WatcherView): void {
    const lines: string[] = [];
    lines.push(`${view.mode.toUpperCase()} mode — clipboard watcher`);
    if (view.countdown !== null) {
      lines.push(
        `  >> Applying ${view.countdown.label} in ${view.countdown.secondsLeft}s — press any key to cancel`,
      );
    }
    lines.push("");

    lines.push("Recent events:");
    if (view.events.length === 0) {
      lines.push("  (none)");
    } else {
      for (const event of view.events.slice(-10)) {
        lines.push(`  #${event.seq} ${event.text}`);
      }
    }
    lines.push("");

    lines.push("Pending proposed writes:");
    if (view.pendingWrites.length === 0) {
      lines.push("  (none)");
    } else {
      for (const pending of view.pendingWrites) {
        lines.push(`  #${pending.seq} ${pending.label} — ${pending.targets.join(", ") || "(no targets)"}`);
        lines.push(`    ${pending.statusNote}`);
      }
    }
    lines.push("");

    lines.push("Latest copied response:");
    if (view.latestResponse === null) {
      lines.push("  (none)");
    } else {
      for (const line of truncate(view.latestResponse, 12).split("\n")) {
        lines.push(`  ${line}`);
      }
    }
    lines.push("");

    lines.push(view.footer);
    this.writeFrame(lines.join("\n"));
  }

  nextKey(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          process.stdin.off("data", onData);
          resolve(null);
        }
      }, timeoutMs);
      const onData = (chunk: Buffer | string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        process.stdin.off("data", onData);
        resolve(chunk.toString());
      };
      process.stdin.on("data", onData);
    });
  }

  readLine(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      let buffer = "";
      let settled = false;
      const draw = (): void => {
        process.stdout.write(`${CLEAR_LINE}${prompt}${buffer}`);
      };
      const onData = (chunk: Buffer | string): void => {
        if (settled) {
          return;
        }
        for (const ch of chunk.toString()) {
          if (ch === "\r" || ch === "\n") {
            settled = true;
            process.stdin.off("data", onData);
            process.stdout.write("\n");
            resolve(buffer);
            return;
          }
          if (ch === "\u007f" || ch === "\u0008") {
            buffer = buffer.slice(0, -1);
            draw();
            continue;
          }
          if (ch === "\u001b") {
            settled = true;
            process.stdin.off("data", onData);
            process.stdout.write("\n");
            resolve(null);
            return;
          }
          if (ch >= " ") {
            buffer += ch;
            draw();
          }
        }
      };
      process.stdout.write(`${CLEAR_LINE}${prompt}`);
      process.stdin.on("data", onData);
    });
  }

  confirm(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      process.stdout.write(`${CLEAR_LINE}${prompt} (y/n) `);
      const onData = (chunk: Buffer | string): void => {
        if (settled) {
          return;
        }
        settled = true;
        process.stdin.off("data", onData);
        const ch = chunk.toString()[0]?.toLowerCase() ?? "";
        process.stdout.write("\n");
        resolve(ch === "y");
      };
      process.stdin.on("data", onData);
    });
  }

  showDetail(text: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      this.writeFrame(`${truncate(text, 200)}\n\nPress any key to close.`);
      const onData = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        process.stdin.off("data", onData);
        resolve();
      };
      process.stdin.on("data", onData);
    });
  }

  close(): void {
    if (this.raw) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* stdin may already be closed on the exit path. */
      }
      process.stdin.pause();
      this.raw = false;
    }
    process.stdout.write(SHOW_CURSOR);
  }

  private writeFrame(text: string): void {
    process.stdout.write(`${CLEAR}${text}\n`);
  }
}