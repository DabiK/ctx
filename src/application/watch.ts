/**
 * `ctx watch` application use case — the foreground clipboard watcher.
 *
 * Observes clipboard changes in a loop, ignores ctx's own responses and
 * duplicate clipboard content (loop prevention), and surfaces tagged
 * patch/write proposals in the TUI for an explicit application action. In
 * safe mode every read request is confirmed; in auto mode valid reads run
 * automatically, but writes always wait for the explicit apply action. The
 * TUI command entry executes supported read operations and automatically
 * copies their structured response.
 *
 * The loop is driven exclusively through application ports: clipboard, git,
 * fs, search, terminal, the TUI port (rendering and keyboard input), and the
 * clock port (tick cadence and event timestamps). No Node or OS code lives
 * here — the real TUI and clock are infrastructure adapters.
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
} from "../protocol.js";
import { copyOrThrow, EXIT_FAILURE, EXIT_OK, fnv1a, requireGitRoot } from "./common.js";
import { RequestUseCase } from "./request.js";
import { buildRefusalResponse } from "./response.js";
import { WriteUseCase } from "./write.js";
import type {
  ClockPort,
  ClipboardPort,
  FsPort,
  GitPort,
  PendingWrite,
  SearchPort,
  TerminalPort,
  TuiPort,
  WatchEvent,
  WatchMode,
  WatcherView,
} from "./ports.js";

export interface WatchOptions {
  allowSensitive: boolean;
}

/** Maximum number of recent events kept in the watcher view. */
const MAX_EVENTS = 50;

/** Key hints shown in the TUI footer. */
function footerHint(mode: WatchMode): string {
  return `[m] mode (${mode})  [e] command  [a] apply pending  [c] cancel  [p] preview  [q] quit`;
}

export class WatchUseCase {
  private readonly requests: RequestUseCase;
  private readonly writes: WriteUseCase;
  private seq = 0;
  private lastSeenHash: string | null = null;
  private stopped = false;
  private mode: WatchMode = "safe";
  private readonly events: WatchEvent[] = [];
  private readonly pendingWrites: PendingWrite[] = [];
  private latestResponse: string | null = null;
  private allowSensitive = false;

  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly terminal: TerminalPort,
    private readonly git: GitPort,
    private readonly fs: FsPort,
    search: SearchPort,
    private readonly tui: TuiPort,
    private readonly clock: ClockPort,
  ) {
    this.requests = new RequestUseCase(clipboard, terminal, git, fs, search);
    this.writes = new WriteUseCase(clipboard, terminal, git, fs, search);
  }

  /**
   * Run the watcher until the user quits. Refuses to start outside a Git
   * repository; every request and write stays inside the repository boundary
   * enforced by the same application use cases as the direct commands.
   */
  async watch(opts: WatchOptions): Promise<number> {
    const root = await requireGitRoot(this.git, this.fs, this.terminal);
    if (root === null) {
      return EXIT_FAILURE;
    }
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

  /** A read request: confirm in safe mode, run automatically in auto mode. */
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
  }

  /** A write proposal: surface it as pending; safe mode confirms first. */
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
    if (this.mode === "safe") {
      const confirmed = await this.tui.confirm(
        `${outcome.label} detected (${outcome.targets.length} target(s)) — add to pending? (y/n)`,
      );
      if (!confirmed) {
        this.logEvent(`${outcome.label} declined — not added to pending.`);
        return;
      }
    }
    this.pendingWrites.push({
      seq: this.nextSeq(),
      label: outcome.label,
      targets: outcome.targets.map((t) => t.relPath),
      statusNote: outcome.statusNote,
      previewText: outcome.response,
      proposal,
    });
    this.logEvent(
      outcome.status === "refused"
        ? `${outcome.label} surfaced as pending (invalid — press p to preview the refusal).`
        : `${outcome.label} surfaced — press a to apply, p to preview, c to cancel.`,
    );
  }

  /** The explicit apply action for the first pending write. */
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
    const outcome = await this.writes.applyParsed(pending.proposal, {
      allowSensitive: this.allowSensitive,
    });
    if (outcome === null) {
      this.logEvent(`Apply failed — see the terminal for details; ${pending.label} stays pending.`);
      return;
    }
    this.latestResponse = outcome.response;
    this.pendingWrites.shift();
    if (outcome.status === "applied") {
      this.logEvent(`${pending.label} applied — ${outcome.targets.length} file(s) changed; response copied.`);
    } else if (outcome.status === "refused") {
      this.logEvent(`${pending.label} refused — nothing changed (refusal copied).`);
    } else {
      this.logEvent(`${pending.label} failed — nothing changed (diagnostic copied).`);
    }
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
  }

  private async handleKey(key: string): Promise<void> {
    const k = key[0]?.toLowerCase() ?? "";
    if (k === "q" || k === "\u0003") {
      this.stopped = true;
      return;
    }
    if (k === "m") {
      this.mode = this.mode === "safe" ? "auto" : "safe";
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
    }
  }

  /** Short description of a parsed request, for confirmation prompts and events. */
  private describeRequest(parsed: ParsedOkRequest): string {
    const labels = parsed.ops.filter(isReadOp).map(describeReadOp);
    return parsed.batch ? `batch (${labels.join(", ")})` : labels.join(", ");
  }

  private modeDescription(): string {
    return this.mode === "safe"
      ? "reads and writes are confirmed"
      : "valid reads run automatically, writes stay pending";
  }

  /** Render the current watcher state through the TUI port. */
  private render(): void {
    const view: WatcherView = {
      mode: this.mode,
      events: this.events.slice(-MAX_EVENTS),
      pendingWrites: [...this.pendingWrites],
      latestResponse: this.latestResponse,
      footer: footerHint(this.mode),
    };
    this.tui.render(view);
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