/**
 * Real foreground TUI adapter for `ctx watch`, rendered through OpenTUI.
 *
 * OpenTUI (`@opentui/core`) is a native Zig-core terminal UI with Flexbox
 * layout, keyboard parsing, and incremental rendering. It is the platform
 * rendering adapter for the watcher: the application `WatchUseCase` keeps
 * driving the loop exclusively through the {@link TuiPort} contract, and every
 * OpenTUI call stays inside this file.
 *
 * Runtime prerequisites: OpenTUI's native library is loaded through FFI.
 * Supported runtimes are Bun 1.3+ (bundles `bun:ffi`) and Node.js 26.4.0
 * started with `--experimental-ffi`. On other runtimes `open()` throws an
 * actionable error and `ctx watch` exits non-zero without touching the
 * terminal, matching the project's missing-prerequisite behaviour.
 *
 * The layout is a full-screen Flexbox column: a status/mode header, recent
 * activity, pending proposed writes, the latest copied response, and a
 * persistent keyboard-help footer. Safe/auto/yolo modes are color-coded, a
 * yolo countdown is rendered in the header, confirm prompts and the command
 * entry appear as rows above the footer, and write previews open as a
 * full-screen overlay. Keyboard input is delivered through the same
 * {@link TuiPort} contract (`nextKey`/`readLine`/`confirm`/`showDetail`) so
 * watcher behaviour stays fully deterministic in tests through the fake.
 */

import {
  BoxRenderable,
  InputRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { EXECUTABLE_NAME } from "../branding.js";
import type { TuiPort, WatcherView, WatchMode } from "../application/ports.js";

/** Mode color coding (hex, readable on light and dark terminals). */
const MODE_COLORS: Record<WatchMode, string> = {
  safe: "#2EA043",
  auto: "#58A6FF",
  yolo: "#E3B341",
};

/** Color used for the yolo countdown line. */
const COUNTDOWN_COLOR = "#F85149";

/** Maximum events rendered in the activity box (older ones get a note). */
const MAX_RENDERED_EVENTS = 15;

/** Maximum pending writes rendered in the pending box (rest get a note). */
const MAX_RENDERED_PENDING = 5;

/** Maximum response lines rendered in the response box. */
const MAX_RESPONSE_LINES = 12;

/** One rendered keystroke from OpenTUI, or `null` for ignored keys. */
function keyToText(key: KeyEvent): string | null {
  if (key.name === "escape") {
    return "\u001b";
  }
  if (key.name === "space") {
    return " ";
  }
  if (key.name === "tab") {
    return "\t";
  }
  if (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") {
    return "\r";
  }
  if (key.name === "backspace") {
    return "\u007f";
  }
  if (key.name === "c" && key.ctrl) {
    return "\u0003";
  }
  // Single-character names (letters, digits, punctuation) are the watcher's
  // action keys; arrows, function keys and modifier chords are not actions.
  if (key.name !== undefined && key.name.length === 1 && !key.ctrl && !key.meta) {
    return key.name;
  }
  return null;
}

/** Truncate long text for the compact view (full content stays in detail). */
function truncate(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`].join("\n");
}

/** True when the running runtime can load the OpenTUI native library. */
function runtimeSupportsOpenTui(): boolean {
  // Bun bundles bun:ffi and ships the matching native core package.
  const versions = (process as { versions?: NodeJS.ProcessVersions }).versions;
  if (
    versions !== undefined &&
    (versions as { bun?: string }).bun !== undefined &&
    typeof (versions as { bun?: string }).bun === "string"
  ) {
    return true;
  }
  // Node.js 26.4.0 started with --experimental-ffi exposes the node:ffi
  // builtin module; every other Node version reports it as undefined.
  try {
    const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    if (typeof getBuiltin === "function") {
      return getBuiltin("node:ffi") !== undefined;
    }
  } catch {
    /* fall through to unsupported */
  }
  return false;
}

/** Actionable prerequisite message for `ctx watch` on unsupported runtimes. */
function prerequisiteMessage(): string {
  return (
    `the watcher TUI needs OpenTUI, which requires Bun 1.3+ or Node.js 26.4.0 ` +
    `(run with --experimental-ffi). Start it with \`bun ${EXECUTABLE_NAME} watch\` ` +
    `(or \`bun dist/cli.js watch\` from a checkout).`
  );
}

export class SystemTui implements TuiPort {
  private renderer: CliRenderer | null = null;
  /** Async initialization (created on `open`); awaited by every interaction. */
  private ready: Promise<void> | null = null;
  private opened = false;
  /** Latest view buffered before the renderer was ready. */
  private view: WatcherView | null = null;

  // Component handles (built once when the renderer is ready).
  private mainBox!: BoxRenderable;
  private detailBox!: BoxRenderable;
  private detailText!: TextRenderable;
  private headerText!: TextRenderable;
  private countdownText!: TextRenderable;
  private eventsText!: TextRenderable;
  private pendingText!: TextRenderable;
  private responseText!: TextRenderable;
  private confirmRow!: BoxRenderable;
  private confirmText!: TextRenderable;
  private commandRow!: BoxRenderable;
  private commandPrompt!: TextRenderable;
  private commandInput!: InputRenderable;
  private footerText!: TextRenderable;

  /** Pending `nextKey` waiters (resolved in order by the next key press). */
  private keyWaiters: ((key: string) => void)[] = [];
  /** Active `confirm` waiter; non-null only while a prompt is on screen. */
  private confirmWaiter: ((yes: boolean) => void) | null = null;
  /** Active `showDetail` waiter; non-null only while the overlay is shown. */
  private detailWaiter: (() => void) | null = null;
  /** Active `readLine` waiter; non-null only while the command row is shown. */
  private inputWaiter: ((value: string | null) => void) | null = null;

  open(): void {
    if (this.opened) {
      return;
    }
    this.opened = true;
    if (!runtimeSupportsOpenTui()) {
      throw new Error(prerequisiteMessage());
    }
    this.ready = this.init();
  }

  render(view: WatcherView): void {
    this.view = view;
    if (this.renderer === null) {
      return; // buffered; applied once the renderer is ready
    }
    this.applyView(view);
  }

  async nextKey(timeoutMs: number): Promise<string | null> {
    await this.ensureReady();
    return new Promise((resolve) => {
      let settled = false;
      const waiter = (key: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(key);
      };
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        const index = this.keyWaiters.indexOf(waiter);
        if (index >= 0) {
          this.keyWaiters.splice(index, 1);
        }
        resolve(null);
      }, timeoutMs);
      this.keyWaiters.push(waiter);
    });
  }

  async readLine(prompt: string): Promise<string | null> {
    await this.ensureReady();
    this.commandPrompt.content = prompt;
    this.commandInput.value = "";
    this.commandRow.visible = true;
    this.commandInput.focus();
    this.requestRender();
    return new Promise((resolve) => {
      this.inputWaiter = resolve;
    });
  }

  async confirm(prompt: string): Promise<boolean> {
    await this.ensureReady();
    this.confirmText.content = `${prompt} (y/n)`;
    this.confirmRow.visible = true;
    this.requestRender();
    return new Promise((resolve) => {
      this.confirmWaiter = resolve;
    });
  }

  async showDetail(text: string): Promise<void> {
    await this.ensureReady();
    this.detailText.content = text;
    this.detailBox.visible = true;
    this.mainBox.visible = false;
    this.requestRender();
    return new Promise((resolve) => {
      this.detailWaiter = resolve;
    });
  }

  close(): void {
    this.renderer?.destroy();
    this.renderer = null;
    this.keyWaiters = [];
    this.confirmWaiter = null;
    this.detailWaiter = null;
    this.inputWaiter = null;
    this.view = null;
  }

  /** OpenTUI key handler: drives the pull-based TuiPort contract. */
  private onKey(key: KeyEvent): void {
    if (this.inputWaiter !== null) {
      // The command Input handles editing keys itself; enter submits and
      // escape cancels the command entry.
      if (key.name === "escape") {
        this.finishInput(null);
      } else if (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") {
        this.finishInput(this.commandInput.value);
      }
      return;
    }
    if (this.confirmWaiter !== null) {
      const answer = key.name?.toLowerCase();
      if (answer === "y" || answer === "n") {
        const waiter = this.confirmWaiter;
        this.confirmWaiter = null;
        this.confirmRow.visible = false;
        this.requestRender();
        waiter(answer === "y");
      }
      return;
    }
    if (this.detailWaiter !== null) {
      const waiter = this.detailWaiter;
      this.detailWaiter = null;
      this.detailBox.visible = false;
      this.mainBox.visible = true;
      this.requestRender();
      waiter();
      return;
    }
    const text = keyToText(key);
    if (text !== null) {
      const waiter = this.keyWaiters.shift();
      waiter?.(text);
    }
  }

  private finishInput(value: string | null): void {
    const waiter = this.inputWaiter;
    this.inputWaiter = null;
    this.commandInput.blur();
    this.commandRow.visible = false;
    this.requestRender();
    waiter?.(value);
  }

  private async init(): Promise<void> {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false, // the watcher handles ctrl-c as its quit key
      targetFps: 30,
      autoFocus: false,
      useMouse: false,
    });
    this.renderer = renderer;
    this.buildTree(renderer);
    renderer.keyInput.on("keypress", (key: KeyEvent) => this.onKey(key));
    if (this.view !== null) {
      this.applyView(this.view);
    }
  }

  private buildTree(renderer: CliRenderer): void {
    this.mainBox = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: 1,
      gap: 1,
    });

    const header = new BoxRenderable(renderer, {
      border: true,
      title: "ctx — clipboard watcher",
      paddingX: 1,
    });
    this.headerText = new TextRenderable(renderer, { content: "" });
    header.add(this.headerText);
    this.countdownText = new TextRenderable(renderer, {
      content: "",
      fg: COUNTDOWN_COLOR,
      visible: false,
    });
    header.add(this.countdownText);
    this.mainBox.add(header);

    const activity = new BoxRenderable(renderer, {
      border: true,
      title: "Recent activity",
      flexGrow: 1,
      paddingX: 1,
    });
    this.eventsText = new TextRenderable(renderer, { content: "" });
    activity.add(this.eventsText);
    this.mainBox.add(activity);

    const pending = new BoxRenderable(renderer, {
      border: true,
      title: "Pending proposed writes",
      paddingX: 1,
    });
    this.pendingText = new TextRenderable(renderer, { content: "" });
    pending.add(this.pendingText);
    this.mainBox.add(pending);

    const response = new BoxRenderable(renderer, {
      border: true,
      title: "Latest copied response",
      paddingX: 1,
    });
    this.responseText = new TextRenderable(renderer, { content: "" });
    response.add(this.responseText);
    this.mainBox.add(response);

    this.confirmRow = new BoxRenderable(renderer, { paddingX: 1, visible: false });
    this.confirmText = new TextRenderable(renderer, { content: "", fg: "#58A6FF" });
    this.confirmRow.add(this.confirmText);
    this.mainBox.add(this.confirmRow);

    this.commandRow = new BoxRenderable(renderer, {
      flexDirection: "row",
      paddingX: 1,
      visible: false,
    });
    this.commandPrompt = new TextRenderable(renderer, { content: `${EXECUTABLE_NAME} > ` });
    this.commandRow.add(this.commandPrompt);
    this.commandInput = new InputRenderable(renderer, {
      value: "",
      flexGrow: 1,
      placeholder: "read command (tree, status, diff …)",
    });
    this.commandRow.add(this.commandInput);
    this.mainBox.add(this.commandRow);

    const footer = new BoxRenderable(renderer, {
      border: true,
      title: "Keys",
      paddingX: 1,
    });
    this.footerText = new TextRenderable(renderer, { content: "" });
    footer.add(this.footerText);
    this.mainBox.add(footer);

    this.detailBox = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: 1,
      border: true,
      title: "Preview — press any key to close",
      visible: false,
    });
    this.detailText = new TextRenderable(renderer, { content: "" });
    this.detailBox.add(this.detailText);

    renderer.root.add(this.mainBox);
    renderer.root.add(this.detailBox);
  }

  private applyView(view: WatcherView): void {
    this.headerText.fg = MODE_COLORS[view.mode] ?? MODE_COLORS.safe;
    this.headerText.content = `${view.mode.toUpperCase()} mode — clipboard watcher`;

    if (view.countdown !== null) {
      this.countdownText.content =
        `>> Applying ${view.countdown.label} in ${view.countdown.secondsLeft}s — press any key to cancel`;
      this.countdownText.visible = true;
    } else {
      this.countdownText.visible = false;
    }

    if (view.events.length === 0) {
      this.eventsText.content = "  (none)";
    } else {
      const shown = view.events.slice(-MAX_RENDERED_EVENTS);
      const overflow =
        view.events.length > shown.length ? `  … (${view.events.length - shown.length} older events)\n` : "";
      this.eventsText.content =
        overflow + shown.map((event) => `  #${event.seq} ${event.text}`).join("\n");
    }

    if (view.pendingWrites.length === 0) {
      this.pendingText.content = "  (none)";
    } else {
      const shown = view.pendingWrites.slice(0, MAX_RENDERED_PENDING);
      const overflow =
        view.pendingWrites.length > shown.length
          ? `  … (${view.pendingWrites.length - shown.length} more pending)\n`
          : "";
      this.pendingText.content =
        overflow +
        shown
          .map(
            (pending) =>
              `  #${pending.seq} ${pending.label} — ${pending.targets.join(", ") || "(no targets)"}\n` +
              `     ${pending.statusNote}`,
          )
          .join("\n");
    }

    this.responseText.content =
      view.latestResponse === null
        ? "  (none)"
        : truncate(view.latestResponse, MAX_RESPONSE_LINES).split("\n").map((l) => `  ${l}`).join("\n");

    this.footerText.content = view.footer;
    this.requestRender();
  }

  private requestRender(): void {
    this.renderer?.requestRender();
  }

  private async ensureReady(): Promise<void> {
    if (this.ready === null) {
      throw new Error("SystemTui is not open");
    }
    await this.ready;
  }
}