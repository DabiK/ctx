/**
 * Terminal port writing to stdout/stderr through console.
 */

import type { TerminalPort } from "../application/ports.js";

/** Terminal backed by stdout/stderr. */
export class SystemTerminal implements TerminalPort {
  info(line: string): void {
    process.stdout.write(line + "\n");
  }

  error(line: string): void {
    process.stderr.write(line + "\n");
  }
}
