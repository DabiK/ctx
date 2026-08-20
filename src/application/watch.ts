/**
 * `ctx watch` application use case — the foreground clipboard watcher.
 *
 * Observes clipboard changes in a loop, ignores ctx's own responses and
 * duplicate clipboard content (loop prevention), and surfaces tagged
 * patch/write proposals in the TUI for an explicit application action. In
 * safe mode every read request is confirmed; in auto mode valid reads run
 * automatically, but writes always wait for the explicit apply action; in
 * yolo mode valid non-sensitive writes auto-apply after a cancellable
 * three-second countdown. The selected mode is persisted in user-local
 * configuration (outside the repository) and restored by later sessions. The
 * TUI command entry executes supported read operations and automatically
 * copies their structured response; optional desktop notifications report
 * request completion and pending/applied write events without replacing TUI
 * diagnostics. A dedicated prompt action copies the same startup protocol as
 * `ctx prompt` — the generated protocol plus the repository-root AGENTS.md
 * when present (or its reported absence) — without creating or overwriting
 * `.ctx.toml`/`.ctxignore` or any other project file.
 *
 * The loop is driven exclusively through application ports: clipboard, git,
 * fs, search, terminal, the TUI port (rendering and keyboard input), the
 * clock port (tick cadence and event timestamps), the user-config port
 * (persisted mode), and the notification port (optional desktop notices). No
 * Node or OS code lives here — the real TUI, clock, user config, and
 * notifications are infrastructure adapters.
 */

import { EXECUTABLE_NAME, PRODUCT_NAME, RESPONSE_MARKER, VERSION } from "../branding.js";
import {
  describeReadOp,
  isProposalRequest,
  isReadOp,
  parseCommandOp,
  parseRequestText,
  singleProposal,
  SUPPORTED_OPS,
  type ParsedOkRequest,
  type Proposal,
} from "../protocol.js";
import {
  buildClipboardPayload,
  copyOrThrow,
  EXIT_FAILURE,
  EXIT_OK,
  fnv1a,
  requireGitRoot,
  utf8ByteLength,
} from "./common.js";
import { RequestUseCase } from "./request.js";
import { buildRefusalResponse } from "./response.js";
import { WriteUseCase, type ApplyOutcome, type PreviewOutcome } from "./write.js";
import type {
  ClockPort,
  ClipboardPort,
  FsPort,
  GitPort,
  NotificationPort,
  PendingWrite,
  SearchPort,
  TerminalPort,
  TuiPort,
  UserConfigPort,
  WatchEvent,
  WatchMode,
  WatcherCountdown,
  WatcherView,
} from "./ports.js";

export interface WatchOptions {
  allowSensitive: boolean;
}

/** Maximum number of recent events kept in the watcher view. */
const MAX_EVENTS = 50;

/** Yolo auto-apply countdown duration in seconds (cancellable). */
const YOLO_COUNTDOWN_SECONDS = 3;

/** Countdown tick cadence (ms): one rendered countdown step per second. */
const COUNTDOWN_TICK_MS = 1000;

/** Mode cycle order for the `m` key. */
const MODES: readonly WatchMode[] = ["safe", "auto", "yolo"];

/** Key hints shown in the TUI footer. */
function footerHint(mode: WatchMode): string {
  const modeHint =
    mode === "yolo"
      ? `[m] mode (yolo: valid writes auto-apply after ${YOLO_COUNTDOWN_SECONDS}s)`
      : `[m] mode (${mode})`;
  return `${modeHint}  [e] command  [a] apply pending  [c] cancel  [p] preview  [i] prompt  [q] quit`;
}

export class WatchUseCase {
  private readonly requests: RequestUseCase;
  private readonly writes: WriteUseCase;
  private seq = 0;
  private lastSeenHash: string | null = null;
  private stopped = false;
  private mode: WatchMode = "safe";
  private repoRoot = "";
  private readonly events: WatchEvent[] = [];
  private readonly pendingWrites: PendingWrite[] = [];
  private latestResponse: string | null = null;
  private countdown: WatcherCountdown | null = null;
  private allowSensitive = false;

  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
    search: SearchPort,
    private readonly tui: TuiPort,
    private readonly clock: ClockPort,
    private readonly userConfig: UserConfigPort,
    private readonly notifications: NotificationPort,
  ) {
    this.requests = new RequestUseCase(clipboard, terminal, git, fs, search);
    this.writes = new WriteUseCase(clipboard, terminal, git, fs, search);
  }

  /**
   * Run the watcher until the user quits. Refuses to start outside a Git
   * repository; every request and write stays inside the repository boundary
   * enforced by the same application use cases as the direct commands. The
   * mode is restored from user-local configuration (defaulting to safe).
   */
  async watch(opts: WatchOptions): Promise<number> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return EXIT_FAILURE;
    }
    this.repoRoot = root;
    this.mode = this.userConfig.readMode() ?? "safe";
    this.allowSensitive = opts.allowSensitive;
    this.tui.open();
    this.logEvent(`${PRODUCT_NAME} ${VERSION} watcher started — mode: ${this.mode}.`);
    this.render();
    while (!this.stopped) {
      const key = await this.tui.nextKey(this.clock.pollIntervalMs());
      if (key === null) {
        await this.pollClipboard();
      } else {
        await this.handleKey(key);
      }
      this.render();
    }
    this.logEvent("Watcher stopped by the user.");
    this.render();
    this.tui.close();
    return EXIT_OK;
  }

  /** One clipboard poll: loop prevention, request parsing, dispatch. */
  private async pollClipboard(): Promise<void> {
    let content: string;
    try {
      content = await this.clipboard.read();
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : "";
      this.logEvent(`Clipboard read failed${detail}.`);
      return;
    }
    if (content.trim() === "") {
      return;
    }

    // Loop prevention: ignore duplicate clipboard content and ctx's own
    // responses so the watcher never reacts to what it copied itself.
    const hash = fnv1a(content);
    if (this.lastSeenHash !== null && hash === this.lastSeenHash) {
      return;
    }
    this.lastSeenHash = hash;
    if (content.trimStart().startsWith(RESPONSE_MARKER)) {
      this.logEvent("Ignored ctx's own clipboard response (loop prevention).");
      return;
    }

    const parsed = parseRequestText(content);
    if (!parsed.ok) {
      // Malformed requests get a structured refusal copied (like `ctx read`);
      // nothing is executed and nothing in the repository changes.
      const response = buildRefusalResponse(parsed.reason, SUPPORTED_OPS);
      await copyOrThrow(response, this.clipboard, this.terminal);
      this.latestResponse = response;
      this.logEvent(`Malformed request refused — ${parsed.reason} (refusal copied).`);
      return;
    }
    if (isProposalRequest(parsed)) {
      await this.handleProposal(parsed);
    } else {
      await this.handleReadRequest(parsed);
    }
  }

  /**
   * A read request: confirm in safe mode, run automatically in auto and yolo
   * modes. Completed requests are reported through the notification port.
   */
  private async handleReadRequest(parsed: ParsedOkRequest): Promise<void> {
    const label = this.describeRequest(parsed);
    if (this.mode === "safe") {
      const confirmed = await this.tui.confirm(`Run ${label}? (y/n)`);
      if (!confirmed) {
        this.logEvent(`Read request declined — ${label}.`);
        return;
      }
    }
    const outcome = await this.requests.execute(parsed, {
      allowSensitive: this.allowSensitive,
    });
    if (outcome === null) {
      this.logEvent("Read request failed — see the terminal for details.");
      return;
    }
    this.latestResponse = outcome.response;
    for (const line of outcome.errorLines) {
      this.logEvent(line);
    }
    for (const line of outcome.infoLines) {
      this.logEvent(line);
    }
    this.notify("Request completed", label);
  }

  /**
   * A write proposal. In safe mode it is confirmed before surfacing; in auto
   * mode it is surfaced as pending; in yolo mode a valid non-sensitive
   * proposal counts down three seconds and auto-applies, while a refused
   * (sensitive without the override, or invalid) proposal is surfaced as
   * pending and never auto-applies.
   */
  private async handleProposal(parsed: ParsedOkRequest): Promise<void> {
    const proposal = singleProposal(parsed);
    if (proposal === null) {
      return;
    }
    const outcome = await this.writes.previewParsed(proposal, this.allowSensitive);
    if (outcome === null) {
      this.logEvent("Write proposal could not be validated — see the terminal for details.");
      return;
    }
    if (this.mode === "yolo") {
      if (outcome.status === "refused") {
        // Sensitive writes stay blocked in yolo unless the explicit
        // sensitive-write override is given (then the proposal validates and
        // counts down like any other).
        this.surfacePending(outcome, proposal);
        this.logEvent(
          `${outcome.label} refused in yolo — never auto-applies (press p to preview the refusal).`,
        );
        this.notify(`${outcome.label} refused`, "Sensitive or invalid proposal — not applied.");
        return;
      }
      await this.applyYoloProposal(outcome, proposal);
      return;
    }
    if (this.mode === "safe") {
      const confirmed = await this.tui.confirm(
        `${outcome.label} detected (${outcome.targets.length} target(s)) — add to pending? (y/n)`,
      );
      if (!confirmed) {
        this.logEvent(`${outcome.label} declined — not added to pending.`);
        return;
      }
    }
    this.surfacePending(outcome, proposal);
    this.notify(
      `${outcome.label} pending`,
      outcome.targets.map((t) => t.relPath).join(", ") || "no targets",
    );
    this.logEvent(
      outcome.status === "refused"
        ? `${outcome.label} surfaced as pending (invalid — press p to preview the refusal).`
        : `${outcome.label} surfaced — press a to apply, p to preview, c to cancel.`,
    );
  }

  /** Yolo path: count down three seconds, then auto-apply (or stay pending on cancel). */
  private async applyYoloProposal(outcome: PreviewOutcome, proposal: Proposal): Promise<void> {
    const completed = await this.runCountdown(outcome.label);
    if (!completed) {
      this.surfacePending(outcome, proposal);
      this.logEvent(
        `${outcome.label} countdown cancelled — stays pending (press a to apply, c to cancel).`,
      );
      this.notify(`${outcome.label} cancelled`, "Countdown cancelled — the proposal stays pending.");
      return;
    }
    await this.applyProposal(proposal, outcome.label);
  }

  /** Add a validated proposal to the pending-write queue. */
  private surfacePending(outcome: PreviewOutcome, proposal: Proposal): void {
    this.pendingWrites.push({
      seq: this.nextSeq(),
      label: outcome.label,
      targets: outcome.targets.map((t) => t.relPath),
      statusNote: outcome.statusNote,
      previewText: outcome.response,
      proposal,
    });
  }

  /**
   * The explicit apply action for the first pending write. Safe mode confirms
   * the application; auto and yolo modes treat it as an explicit action.
   */
  private async applyPendingWrite(): Promise<void> {
    const pending = this.pendingWrites[0];
    if (pending === undefined) {
      this.logEvent("No pending write to apply.");
      return;
    }
    if (this.mode === "safe") {
      const confirmed = await this.tui.confirm(
        `Apply ${pending.label} (${pending.targets.join(", ") || "no targets"})? (y/n)`,
      );
      if (!confirmed) {
        this.logEvent(`Apply declined — ${pending.label} stays pending.`);
        return;
      }
    }
    const outcome = await this.applyProposal(pending.proposal, pending.label);
    if (outcome !== null) {
      this.pendingWrites.shift();
    }
  }

  /**
   * Apply a proposal through the shared write path and report the outcome
   * through the event log and the notification port. Returns `null` when the
   * infrastructure failed (the proposal stays pending); otherwise the outcome
   * (applied, refused, or failed) with the copied response.
   */
  private async applyProposal(proposal: Proposal, label: string): Promise<ApplyOutcome | null> {
    const outcome = await this.writes.applyParsed(proposal, {
      allowSensitive: this.allowSensitive,
    });
    if (outcome === null) {
      this.logEvent(`Apply failed — see the terminal for details; ${label} stays pending.`);
      return null;
    }
    this.latestResponse = outcome.response;
    if (outcome.status === "applied") {
      this.logEvent(`${label} applied — ${outcome.targets.length} file(s) changed; response copied.`);
      this.notify(`${label} applied`, `${outcome.targets.length} file(s) changed; ${RESPONSE_MARKER} copied.`);
    } else if (outcome.status === "refused") {
      this.logEvent(`${label} refused — nothing changed (refusal copied).`);
      this.notify(`${label} refused`, "Nothing changed (refusal copied).");
    } else {
      this.logEvent(`${label} failed — nothing changed (diagnostic copied).`);
      this.notify(`${label} failed`, "Nothing changed (diagnostic copied).");
    }
    return outcome;
  }

  /** Cancel (remove) the first pending write without applying it. */
  private async cancelPendingWrite(): Promise<void> {
    const pending = this.pendingWrites[0];
    if (pending === undefined) {
      this.logEvent("No pending write to cancel.");
      return;
    }
    this.pendingWrites.shift();
    this.logEvent(`Cancelled pending ${pending.label}.`);
  }

  /** Show the full preview/refusal text of the first pending write. */
  private async previewPendingWrite(): Promise<void> {
    const pending = this.pendingWrites[0];
    if (pending === undefined) {
      this.logEvent("No pending write to preview.");
      return;
    }
    await this.tui.showDetail(pending.previewText);
    this.logEvent(`Previewed ${pending.label} (press p again to re-show).`);
  }

  /**
   * Yolo countdown: render the remaining whole seconds, one per tick, and
   * resolve `true` when it completes untouched or `false` when the user
   * presses any key (cancelled — the proposal is never auto-applied).
   */
  private async runCountdown(label: string): Promise<boolean> {
    for (let remaining = YOLO_COUNTDOWN_SECONDS; remaining > 0; remaining--) {
      this.countdown = { label, secondsLeft: remaining };
      this.render();
      const key = await this.tui.nextKey(COUNTDOWN_TICK_MS);
      if (key !== null) {
        this.countdown = null;
        return false;
      }
    }
    this.countdown = null;
    return true;
  }

  /**
   * The dedicated prompt action (`i`): copy the same startup protocol as
   * `ctx prompt` — the generated protocol plus the repository-root AGENTS.md
   * when present (or its reported absence). It never creates or overwrites
   * `.ctx.toml`/`.ctxignore` or any other project file. The copied payload's
   * hash is recorded for loop prevention so the watcher never re-executes the
   * prompt it just copied (it contains `@ctx` examples, which must stay
   * documentation, not requests).
   */
  private async copyProtocolPrompt(): Promise<void> {
    const payload = buildClipboardPayload(this.repoRoot, this.fs, false);
    try {
      await this.clipboard.copy(payload);
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : "";
      this.logEvent(`Protocol prompt copy failed${detail}.`);
      return;
    }
    this.lastSeenHash = fnv1a(payload);
    const bytes = utf8ByteLength(payload);
    this.logEvent(`Startup protocol copied to the clipboard (${bytes} bytes).`);
    this.notify("Protocol prompt copied", `${bytes} bytes on the clipboard.`);
  }

  /** The TUI command entry: run a supported read command and copy its response. */
  private async commandEntry(): Promise<void> {
    const line = await this.tui.readLine(`${EXECUTABLE_NAME} > `);
    if (line === null || line.trim() === "") {
      this.logEvent("Command entry cancelled.");
      return;
    }
    const parsed = parseCommandOp(line);
    if (!parsed.ok) {
      this.logEvent(`Command refused — ${parsed.reason}.`);
      return;
    }
    const request: ParsedOkRequest = {
      ok: true,
      ops: [parsed.op],
      batch: false,
      sequence: false,
    };
    const outcome = await this.requests.execute(request, {
      allowSensitive: this.allowSensitive,
    });
    if (outcome === null) {
      this.logEvent(`Command failed — see the terminal for details.`);
      return;
    }
    this.latestResponse = outcome.response;
    for (const line of outcome.errorLines) {
      this.logEvent(line);
    }
    for (const line of outcome.infoLines) {
      this.logEvent(line);
    }
    this.logEvent(`Command executed: ${line} — response copied.`);
    this.notify("Command completed", line);
  }

  private async handleKey(key: string): Promise<void> {
    const k = key[0]?.toLowerCase() ?? "";
    if (k === "q" || k === "\u0003") {
      this.stopped = true;
      return;
    }
    if (k === "m") {
      const index = MODES.indexOf(this.mode);
      this.mode = MODES[(index + 1) % MODES.length] ?? "safe";
      this.userConfig.writeMode(this.mode);
      this.logEvent(`Mode switched to ${this.mode} — ${this.modeDescription()}.`);
      return;
    }
    if (k === "e") {
      await this.commandEntry();
      return;
    }
    if (k === "a") {
      await this.applyPendingWrite();
      return;
    }
    if (k === "c") {
      await this.cancelPendingWrite();
      return;
    }
    if (k === "p") {
      await this.previewPendingWrite();
      return;
    }
    if (k === "i") {
      await this.copyProtocolPrompt();
      return;
    }
  }

  /** Short description of a parsed request, for confirmation prompts and events. */
  private describeRequest(parsed: ParsedOkRequest): string {
    const labels = parsed.ops.filter(isReadOp).map(describeReadOp);
    return parsed.batch ? `batch (${labels.join(", ")})` : labels.join(", ");
  }

  private modeDescription(): string {
    if (this.mode === "safe") {
      return "reads and writes are confirmed";
    }
    if (this.mode === "auto") {
      return "valid reads run automatically, writes stay pending";
    }
    return `valid reads run automatically; valid non-sensitive writes auto-apply after ${YOLO_COUNTDOWN_SECONDS}s`;
  }

  /** Render the current watcher state through the TUI port. */
  private render(): void {
    const view: WatcherView = {
      mode: this.mode,
      events: this.events.slice(-MAX_EVENTS),
      pendingWrites: [...this.pendingWrites],
      latestResponse: this.latestResponse,
      countdown: this.countdown,
      footer: footerHint(this.mode),
    };
    this.tui.render(view);
  }

  /** One optional desktop notification (never replaces TUI diagnostics). */
  private notify(title: string, body: string): void {
    this.notifications.notify(title, body);
  }

  /** Append one event and cap the log. */
  private logEvent(text: string): void {
    this.events.push({ seq: this.nextSeq(), at: this.clock.now(), text });
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  private nextSeq(): number {
    return ++this.seq;
  }
}