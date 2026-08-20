/**
 * Real clock adapter for `ctx watch`: the system clock and a fixed clipboard
 * poll interval. Tests inject a scripted fake instead.
 */

import type { ClockPort } from "../application/ports.js";

/** Default clipboard poll cadence (ms): the loop checks the clipboard on every tick. */
const POLL_INTERVAL_MS = 750;

/** Clock backed by the running Node process. */
export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }

  pollIntervalMs(): number {
    return POLL_INTERVAL_MS;
  }
}